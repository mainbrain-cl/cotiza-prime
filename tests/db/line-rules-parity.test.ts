// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · H-041 · migración 20261118100000 · la regla de precio y descuento está escrita dos veces: en SQL (la que manda:
// `app.line_rule_issues` y `app.locked_price_override_lines`) y en TypeScript (`src/lib/quotes/line-rules.ts`, la de la pantalla).
// Aquí se exige que respondan IGUAL: con la tabla de casos compartida (`line-rules-cases.ts`) y con 2.000 casos al azar de semilla
// fija, con muchos puestos justo en el borde del tope (el mismo peso arriba o abajo). Todo es ficticio.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  formatLineRuleIssue,
  lineRuleIssues,
  lockedPriceOverrides,
  maxDiscountClp,
  type LineRulesInput,
  type RuleLine,
} from "../../src/lib/quotes/line-rules";
import { LINE_RULE_CASES } from "../../src/lib/quotes/line-rules-cases";
import type { Discount } from "../../src/lib/quotes/calc";
import { connect } from "./helpers";

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

const dbDiscount = (d: Discount) =>
  d.kind === "none"
    ? { kind: "none", value: 0 }
    : d.kind === "percent"
      ? { kind: "percent", value: d.bp }
      : { kind: "amount", value: d.clp };

const toDbLine = (l: RuleLine) => ({
  price_locked: l.priceLocked,
  catalog_unit_price_clp: l.catalogUnitPriceClp,
  unit_price_clp: l.unitPriceClp,
  discount_kind: dbDiscount(l.discount).kind,
  discount_value: dbDiscount(l.discount).value,
  gross_clp: l.grossClp,
});

/** Lo que responde la base para esta entrada. */
async function sqlAnswer(
  input: LineRulesInput,
): Promise<{ issues: string[]; overrides: number[] }> {
  const global = input.global
    ? {
        kind: dbDiscount(input.global.discount).kind,
        value: dbDiscount(input.global.discount).value,
        base_clp: input.global.baseClp,
      }
    : null;
  const lines = JSON.stringify(input.lines.map(toDbLine));
  const { rows } = await db.query<{ issues: string[]; overrides: number[] }>(
    `select app.line_rule_issues($1::jsonb, $2::jsonb, $3::integer, $4::boolean) as issues,
            app.locked_price_override_lines($1::jsonb) as overrides`,
    [
      lines,
      global === null ? null : JSON.stringify(global),
      input.maxDiscountBp,
      input.canOverride,
    ],
  );
  return rows[0];
}

describe("paridad SQL / TypeScript: la tabla de casos", () => {
  for (const c of LINE_RULE_CASES) {
    it(c.name, async () => {
      const answer = await sqlAnswer(c.input);
      expect(answer.issues).toEqual(c.issues);
      expect(answer.overrides).toEqual(c.overrides);
      // y las dos son la misma
      expect(lineRuleIssues(c.input).map(formatLineRuleIssue)).toEqual(answer.issues);
      expect(lockedPriceOverrides(c.input.lines)).toEqual(answer.overrides);
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
  it("2.000 combinaciones de candados, topes, descuentos y montos dan lo mismo", async () => {
    const random = seeded(20261118);
    const int = (max: number) => Math.floor(random() * (max + 1));
    const MAX = 999_999_999_999;
    // Magnitudes de muchos tamaños, hasta el máximo, para tocar el borde del entero seguro de JavaScript.
    const magnitude = () => Math.min(MAX, int(10 ** (1 + int(11))));
    const mismatches: string[] = [];
    const kinds = new Set<string>();
    let clean = 0;

    for (let i = 0; i < 2000; i += 1) {
      const maxDiscountBp = random() < 0.2 ? null : random() < 0.1 ? 0 : int(9_999);
      const discountFor = (gross: number): Discount => {
        const roll = random();
        if (roll < 0.25) return { kind: "none" };
        // Con tope, la mitad de los casos cae JUSTO en el borde (el mismo peso o punto base arriba o abajo).
        const nearEdge = maxDiscountBp !== null && random() < 0.5;
        if (roll < 0.6) {
          const base = nearEdge ? maxDiscountBp + int(2) - 1 : int(10_000);
          return { kind: "percent", bp: Math.min(10_000, Math.max(0, base)) };
        }
        const edge = maxDiscountBp === null ? 0 : Number(maxDiscountClp(gross, maxDiscountBp));
        const base = nearEdge ? edge + int(2) - 1 : int(gross);
        return { kind: "amount", clp: Math.min(gross, Math.max(0, base)) };
      };
      const lineCount = int(4);
      const lines: RuleLine[] = Array.from({ length: lineCount }, () => {
        const grossClp = magnitude();
        const isFree = random() < 0.2;
        const catalogUnitPriceClp = isFree ? null : magnitude();
        return {
          priceLocked: random() < 0.5,
          catalogUnitPriceClp,
          unitPriceClp:
            catalogUnitPriceClp !== null && random() < 0.5
              ? catalogUnitPriceClp
              : catalogUnitPriceClp !== null && random() < 0.3
                ? catalogUnitPriceClp + (random() < 0.5 ? 1 : -1)
                : magnitude(),
          discount: discountFor(grossClp),
          grossClp,
        };
      });
      // Un precio unitario negativo no existe: si el «−1» se pasó de cero, vuelve a cero.
      for (const line of lines) line.unitPriceClp = Math.max(0, line.unitPriceClp);
      const baseClp = magnitude();
      const input: LineRulesInput = {
        lines,
        global: random() < 0.6 ? { discount: discountFor(baseClp), baseClp } : null,
        maxDiscountBp,
        canOverride: random() < 0.1,
      };
      const sql = await sqlAnswer(input);
      if (sql.issues.length === 0) clean += 1;
      for (const issue of sql.issues) kinds.add(issue.replace(/@\d+$/, ""));
      const ts = {
        issues: lineRuleIssues(input).map(formatLineRuleIssue),
        overrides: lockedPriceOverrides(input.lines),
      };
      if (sql.issues.join() !== ts.issues.join() || sql.overrides.join() !== ts.overrides.join()) {
        mismatches.push(JSON.stringify({ input, sql, ts }));
        if (mismatches.length >= 5) break;
      }
    }
    expect(mismatches).toEqual([]);
    // la prueba no es vacía: salen los tres problemas y también casos limpios
    expect([...kinds].sort()).toEqual([
      "discount_over_cap",
      "global_discount_over_cap",
      "price_locked",
    ]);
    expect(clean).toBeGreaterThan(100);
    expect(clean).toBeLessThan(1_900);
  });

  it("el generador sí produce casos con problemas y casos sin problemas (la prueba no es vacía)", async () => {
    const random = seeded(7);
    const seen = { issues: 0, clean: 0 };
    for (let i = 0; i < 200; i += 1) {
      const grossClp = 1_000 + Math.floor(random() * 100_000);
      const input: LineRulesInput = {
        lines: [
          {
            priceLocked: random() < 0.5,
            catalogUnitPriceClp: 1_000,
            unitPriceClp: random() < 0.5 ? 1_000 : 999,
            discount: { kind: "percent", bp: Math.floor(random() * 2_000) },
            grossClp,
          },
        ],
        global: null,
        maxDiscountBp: 1_000,
        canOverride: false,
      };
      const sql = await sqlAnswer(input);
      if (sql.issues.length > 0) seen.issues += 1;
      else seen.clean += 1;
    }
    expect(seen.issues).toBeGreaterThan(20);
    expect(seen.clean).toBeGreaterThan(20);
  });
});
