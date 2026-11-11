// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · migración 20261110110000 · la función que decide si una cotización necesita aprobación está escrita dos veces:
// en SQL (la que manda: `app.approval_discount_bp`, `app.approval_rule_reasons`, `app.quote_approval_check`) y en TypeScript
// (`src/lib/approvals/rule.ts`, la de la pantalla). Aquí se exige que respondan IGUAL: con la tabla de casos compartida
// (`rule-cases.ts`), con 3.000 casos al azar de semilla fija y con cotizaciones de verdad armadas por el cálculo oficial.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RULE_CASES } from "../../src/lib/approvals/rule-cases";
import {
  APPROVAL_AMOUNT_MAX_CLP,
  APPROVAL_DISCOUNT_MAX_BP,
  approvalMetrics,
  approvalReasons,
  priceRebateOfLines,
  type ApprovalRule,
  type ApprovalTotals,
} from "../../src/lib/approvals/rule";
import { actAsPostgres, connect, withTx } from "./helpers";
import { addCatalogItem, createQuoteWith, type QuoteSpec } from "./approval-helpers";
import { buildWorld, type World } from "./send-helpers";

let db: Client;
let w: World;
beforeAll(async () => {
  db = await connect();
  w = await buildWorld(db);
});
afterAll(async () => {
  await db.end();
});

type SqlAnswer = { discountBp: number; reasons: string[] };

/** Lo que responde la base para estos totales y esta regla. */
async function sqlAnswer(rule: ApprovalRule, totals: ApprovalTotals): Promise<SqlAnswer> {
  const gross = totals.subtotalClp + totals.lineDiscountsClp + totals.priceRebateClp;
  const discount = totals.lineDiscountsClp + totals.globalDiscountClp + totals.priceRebateClp;
  const { rows } = await db.query<{ bp: number; reasons: string[] }>(
    `select app.approval_discount_bp($1::bigint, $2::bigint) as bp,
            app.approval_rule_reasons($3, $4::bigint, $5::integer, $6::bigint, $2::bigint,
                                      app.approval_discount_bp($1::bigint, $2::bigint)) as reasons`,
    [
      gross,
      discount,
      rule.mode,
      rule.amountThresholdClp,
      rule.discountThresholdBp,
      totals.totalClp,
    ],
  );
  return { discountBp: rows[0].bp, reasons: rows[0].reasons };
}

describe("paridad SQL / TypeScript: la tabla de casos", () => {
  for (const c of RULE_CASES) {
    it(c.name, async () => {
      const answer = await sqlAnswer(c.rule, c.totals);
      expect(answer.discountBp).toBe(c.discountBp);
      expect(answer.reasons).toEqual(c.reasons);
      // y las dos son la misma
      const metrics = approvalMetrics(c.totals);
      expect(answer.discountBp).toBe(metrics.discountBp);
      expect(answer.reasons).toEqual(approvalReasons(c.rule, metrics));
    });
  }
});

/** Generador con semilla fija (mulberry32): el mismo conjunto de casos en cada corrida. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("paridad SQL / TypeScript: casos al azar de semilla fija", () => {
  it("3.000 combinaciones de montos, descuentos y reglas dan lo mismo", async () => {
    const random = seeded(20261110);
    const int = (max: number) => Math.floor(random() * (max + 1));
    // Magnitudes de muchos tamaños, hasta el máximo, para tocar el borde del entero seguro de JavaScript.
    const magnitude = () => int(10 ** (1 + int(11))) % (APPROVAL_AMOUNT_MAX_CLP + 1);
    const modes = ["never", "always", "conditional", "conditional", "conditional"] as const;
    const mismatches: string[] = [];
    for (let i = 0; i < 3000; i += 1) {
      const subtotalClp = magnitude();
      const lineDiscountsClp =
        random() < 0.4 ? 0 : int(Math.min(subtotalClp * 2, 10 ** 12 - 1 - subtotalClp));
      const globalDiscountClp = random() < 0.5 ? 0 : int(subtotalClp);
      const priceRebateClp =
        random() < 0.5
          ? 0
          : int(Math.min(subtotalClp, 10 ** 12 - 1 - subtotalClp - lineDiscountsClp));
      const totals: ApprovalTotals = {
        priceRebateClp,
        subtotalClp,
        lineDiscountsClp,
        globalDiscountClp,
        totalClp: Math.min(APPROVAL_AMOUNT_MAX_CLP, Math.round(subtotalClp * 1.19)),
      };
      const mode = modes[int(modes.length - 1)];
      const rule: ApprovalRule =
        mode === "conditional"
          ? {
              mode,
              amountThresholdClp:
                random() < 0.6
                  ? 1 + (int(Math.max(1, totals.totalClp * 2)) % APPROVAL_AMOUNT_MAX_CLP)
                  : null,
              discountThresholdBp: random() < 0.6 ? int(APPROVAL_DISCOUNT_MAX_BP) : null,
            }
          : { mode, amountThresholdClp: null, discountThresholdBp: null };
      if (
        mode === "conditional" &&
        rule.amountThresholdClp === null &&
        rule.discountThresholdBp === null
      ) {
        rule.discountThresholdBp = 0;
      }
      const ts = approvalMetrics(totals);
      const tsReasons = approvalReasons(rule, ts);
      const sql = await sqlAnswer(rule, totals);
      if (sql.discountBp !== ts.discountBp || sql.reasons.join() !== tsReasons.join()) {
        mismatches.push(JSON.stringify({ rule, totals, sql, ts: { ...ts, tsReasons } }));
        if (mismatches.length >= 5) break;
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("paridad con cotizaciones de verdad (el cálculo oficial → quotes → quote_approval_check)", () => {
  const specs: [string, QuoteSpec][] = [
    ["neto $1.680.672 (total $2.000.000)", { lines: [{ price: 1_680_672 }] }],
    ["neto $1.680.673 (total $2.000.001)", { lines: [{ price: 1_680_673 }] }],
    [
      "línea de $1.005 con 10 %",
      { lines: [{ price: 1_005, discount: { kind: "percent", bp: 1_000 } }] },
    ],
    [
      "línea de $2.000.005 con 10 %",
      { lines: [{ price: 2_000_005, discount: { kind: "percent", bp: 1_000 } }] },
    ],
    [
      "línea 6 % más general 5 %",
      {
        lines: [{ price: 1_000_000, discount: { kind: "percent", bp: 600 } }],
        globalDiscount: { kind: "percent", bp: 500 },
      },
    ],
    [
      "solo general de 15 %",
      { lines: [{ price: 1_000_000 }], globalDiscount: { kind: "percent", bp: 1_500 } },
    ],
    [
      "descuento en pesos y una línea exenta",
      {
        lines: [
          { price: 500_000, discount: { kind: "amount", clp: 12_345 } },
          { price: 250_000, exempt: true },
        ],
        globalDiscount: { kind: "amount", clp: 10_000 },
      },
    ],
    ["sin descuento", { lines: [{ price: 40_000, qtyMilli: 2_500 }] }],
  ];
  /** Cotizaciones con servicios del catálogo y precios puestos a mano: `rebate` es la rebaja que debe dar la cuenta, en pesos. */
  type Cat = { a: string; b: string };
  const catalogSpecs: [string, (cat: Cat) => QuoteSpec, number][] = [
    ["a precio de catálogo", (c) => ({ lines: [{ price: 10_000, catalogItemId: c.a }] }), 0],
    [
      "precio bajado a mano ($8.000 contra $10.000, 2,5 unidades)",
      (c) => ({ lines: [{ price: 8_000, qtyMilli: 2_500, catalogItemId: c.a }] }),
      5_000,
    ],
    [
      "precio mayor al catálogo, con un descuento de línea de 10 %",
      (c) => ({
        lines: [{ price: 12_000, discount: { kind: "percent", bp: 1_000 }, catalogItemId: c.a }],
      }),
      0,
    ],
    [
      "una línea cara no compensa a una barata",
      (c) => ({
        lines: [
          { price: 8_000, catalogItemId: c.a },
          { price: 30_000, catalogItemId: c.b },
        ],
      }),
      2_000,
    ],
    [
      "una línea libre barata junto a una de catálogo a su precio: sin rebaja",
      (c) => ({ lines: [{ price: 10_000, catalogItemId: c.a }, { price: 1 }] }),
      0,
    ],
    [
      "rebaja más descuento de línea y general",
      (c) => ({
        lines: [{ price: 9_000, discount: { kind: "percent", bp: 500 }, catalogItemId: c.a }],
        globalDiscount: { kind: "percent", bp: 500 },
      }),
      1_000,
    ],
    [
      "redondeo: 0,5 unidades de $1.001 de catálogo, puestas a $800",
      (c) => ({ lines: [{ price: 800, qtyMilli: 500, catalogItemId: c.b }] }),
      101,
    ],
    ["precio 0 contra el catálogo", (c) => ({ lines: [{ price: 0, catalogItemId: c.a }] }), 10_000],
  ];
  const rules: ApprovalRule[] = [
    { mode: "never", amountThresholdClp: null, discountThresholdBp: null },
    { mode: "always", amountThresholdClp: null, discountThresholdBp: null },
    { mode: "conditional", amountThresholdClp: 2_000_000, discountThresholdBp: null },
    { mode: "conditional", amountThresholdClp: null, discountThresholdBp: 1_000 },
    { mode: "conditional", amountThresholdClp: 2_000_000, discountThresholdBp: 1_000 },
    { mode: "conditional", amountThresholdClp: null, discountThresholdBp: 0 },
  ];

  it("cada cotización contra cada regla: la base y TypeScript piden aprobación por los mismos motivos", async () => {
    await withTx(db, async () => {
      const cat: Cat = {
        a: await addCatalogItem(db, w.tenantA, 10_000),
        b: await addCatalogItem(db, w.tenantA, 1_001),
      };
      const cases = [
        ...specs.map(([name, spec]) => ({ name, spec, expectedRebate: 0 })),
        ...catalogSpecs.map(([name, build, expectedRebate]) => ({
          name,
          spec: build(cat),
          expectedRebate,
        })),
      ];
      for (const { name, spec, expectedRebate } of cases) {
        const { quoteId, totals } = await createQuoteWith(
          db,
          w.owner,
          w.tenantA,
          w.customerA,
          spec,
        );
        // La rebaja de precio sale de las líneas GUARDADAS, igual que en la pantalla de enviar.
        await actAsPostgres(db);
        const { rows: items } = await db.query<{
          quantity_milli: string;
          gross_clp: string;
          catalog_unit_price_clp: string | null;
        }>(
          "select quantity_milli, gross_clp, catalog_unit_price_clp from public.quote_items where quote_id = $1",
          [quoteId],
        );
        const priceRebateClp = priceRebateOfLines(
          items.map((i) => ({
            quantityMilli: Number(i.quantity_milli),
            grossClp: Number(i.gross_clp),
            catalogUnitPriceClp:
              i.catalog_unit_price_clp === null ? null : Number(i.catalog_unit_price_clp),
          })),
        );
        expect(priceRebateClp, name).toBe(expectedRebate);
        const ts = approvalMetrics({
          subtotalClp: totals.subtotalClp,
          lineDiscountsClp: totals.lineDiscountsClp,
          globalDiscountClp: totals.globalDiscountClp,
          totalClp: totals.totalClp,
          priceRebateClp,
        });
        for (const rule of rules) {
          await actAsPostgres(db);
          // La regla vigente de la organización de la fixture se reemplaza por una fila nueva (como postgres, dentro de
          // la transacción que se deshace): así `quote_approval_check` lee exactamente esta regla.
          const { rows: last } = await db.query<{ version: number }>(
            "select max(version) as version from public.approval_rules where tenant_id = $1",
            [w.tenantA],
          );
          await db.query(
            `insert into public.approval_rules
               (tenant_id, version, mode, amount_threshold_clp, discount_threshold_bp, created_by)
             values ($1, $2, $3, $4, $5, $6)`,
            [
              w.tenantA,
              last[0].version + 1,
              rule.mode,
              rule.amountThresholdClp,
              rule.discountThresholdBp,
              w.owner.id,
            ],
          );
          const { rows } = await db.query<{
            r: { required: boolean; reasons: string[]; metrics: Record<string, number> };
          }>("select app.quote_approval_check($1, $2) as r", [w.tenantA, quoteId]);
          const label = `${name} / ${JSON.stringify(rule)}`;
          expect(rows[0].r.reasons, label).toEqual(approvalReasons(rule, ts));
          expect(rows[0].r.required, label).toBe(approvalReasons(rule, ts).length > 0);
          expect(rows[0].r.metrics, label).toEqual({
            total_clp: ts.totalClp,
            discount_clp: ts.discountClp,
            discount_bp: ts.discountBp,
            price_rebate_clp: ts.priceRebateClp,
          });
        }
      }
    });
  });

  it("los totales salen de la base: una cotización de otra organización no existe para esta", async () => {
    await withTx(db, async () => {
      const { quoteId } = await createQuoteWith(db, w.owner, w.tenantA, w.customerA, {
        lines: [{ price: 1_000 }],
      });
      await actAsPostgres(db);
      await expect(
        db.query("select app.quote_approval_check($1, $2)", [w.tenantB, quoteId]),
      ).rejects.toMatchObject({ code: "CP404" });
    });
  });
});
