// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · H-041 · el CONTRATO de `public.save_quote_draft` con quienes la extienden después (H-042 servicios por comercial, H-048b
// textos al cotizar, ya construida). Es una prueba trampa: dentro de una transacción que se deshace, reemplaza el gancho `app.can_quote_catalog_item`
// por uno que dice «no» y comprueba que `save_quote_draft` de verdad lo consulta, solo para líneas NUEVAS del catálogo, con el mismo
// formato de error de las demás reglas. Si alguien reescribe `save_quote_draft` y deja el gancho desconectado, esta prueba cae.
// También vigila que sigan vivas las tres reglas de H-041. H-048b le sumó sus casos (abajo).
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateQuote } from "../../src/lib/quotes/calc";
import { actAsPostgres, connect, expectSqlError, withTx, type TestUser } from "./helpers";
import { addCatalogItem } from "./approval-helpers";
import { asUser, buildWorld, line, type World } from "./send-helpers";

let db: Client;
let w: World;
beforeAll(async () => {
  db = await connect();
  w = await buildWorld(db);
});
afterAll(async () => {
  await db.end();
});

const SAVE = "select public.save_quote_draft($1, $2, $3, $4, $5, $6) as r";
const PRICE = 10_000;

/** Reemplaza el gancho dentro de la transacción de la prueba (se deshace al terminar). */
async function replaceHook(body: string) {
  await actAsPostgres(db);
  await db.query(
    `create or replace function app.can_quote_catalog_item(p_catalog_item_id uuid) returns boolean
     language sql stable security definer set search_path = '' as $$ ${body} $$`,
  );
}

async function newQuote(user: TestUser): Promise<string> {
  await asUser(db, user, w.tenantA);
  const { rows } = await db.query<{ quote_id: string }>(
    "select * from public.create_quote($1, $2)",
    [w.customerA, randomUUID()],
  );
  await actAsPostgres(db);
  return rows[0].quote_id;
}

type L = { id: string; catalogItemId?: string; price?: number };
function body(lines: L[], discountBp = 0) {
  const calc = calculateQuote({
    lines: lines.map((l) => ({
      quantityMilli: 1000,
      unitPriceClp: l.price ?? PRICE,
      taxTreatment: "taxable" as const,
      discount:
        discountBp > 0 ? { kind: "percent" as const, bp: discountBp } : { kind: "none" as const },
    })),
    globalDiscount: { kind: "none" },
    taxRateBp: 1900,
  });
  if (!calc.ok) throw new Error("cálculo de prueba inválido");
  return [
    JSON.stringify({ customer_id: w.customerA, global_discount: { kind: "none", value: 0 } }),
    JSON.stringify(
      lines.map((l) =>
        line({
          id: l.id,
          unit_price_clp: l.price ?? PRICE,
          discount_kind: discountBp > 0 ? "percent" : "none",
          discount_value: discountBp,
          ...(l.catalogItemId ? { catalog_item_id: l.catalogItemId } : {}),
        }),
      ),
    ),
    JSON.stringify(calc.totals),
  ];
}
async function revision(quoteId: string): Promise<number> {
  await actAsPostgres(db);
  return (
    await db.query<{ revision: number }>("select revision from public.quotes where id = $1", [
      quoteId,
    ])
  ).rows[0].revision;
}
async function saveOk(user: TestUser, quoteId: string, lines: L[]) {
  const rev = await revision(quoteId);
  await asUser(db, user, w.tenantA);
  await db.query(SAVE, [quoteId, rev, randomUUID(), ...body(lines)]);
  await actAsPostgres(db);
}
async function saveFails(user: TestUser, quoteId: string, lines: L[], discountBp = 0) {
  const rev = await revision(quoteId);
  await asUser(db, user, w.tenantA);
  const error = await expectSqlError(db, SAVE, [
    quoteId,
    rev,
    randomUUID(),
    ...body(lines, discountBp),
  ]);
  await actAsPostgres(db);
  return error;
}

describe("el gancho de servicios por comercial (H-042)", () => {
  it("hoy responde «sí» a todo y `save_quote_draft` lo consulta", async () => {
    await actAsPostgres(db);
    const { rows } = await db.query<{ ok: boolean; src: string }>(
      `select app.can_quote_catalog_item($1) as ok,
              (select prosrc from pg_proc where oid = 'public.save_quote_draft(uuid, integer, uuid, jsonb, jsonb, jsonb)'::regprocedure) as src`,
      [randomUUID()],
    );
    expect(rows[0].ok).toBe(true);
    // si alguien reescribe `save_quote_draft`, tiene que seguir consultando el gancho y la regla
    expect(rows[0].src).toContain("app.can_quote_catalog_item(");
    expect(rows[0].src).toContain("app.quote_line_rules_check(");
    expect(rows[0].src).toContain("app.can('quote.edit', true)");
    // y los dos textos de H-048b (exclusiones y notas al pie), con el tope de la base
    expect(rows[0].src).toContain("'exclusions', 'footer_note'");
    expect(rows[0].src).toContain("v_excl");
    expect(rows[0].src).toContain("v_note");
    expect(rows[0].src).toContain("app.quote_text_max_length()");
  });

  it("con el gancho en «no», una línea NUEVA del catálogo se rechaza: CP422 `catalog_item_not_allowed@0` y no se guarda nada", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, PRICE);
      const quoteId = await newQuote(w.sales);
      await replaceHook("select false");
      const error = await saveFails(w.sales, quoteId, [
        { id: randomUUID(), catalogItemId: service },
      ]);
      expect(error.code).toBe("CP422");
      expect(error.message).toBe("line_rules_invalid: catalog_item_not_allowed@0");
      expect(await revision(quoteId)).toBe(1);
    }));

  it("una línea EXISTENTE del mismo servicio se sigue guardando; una nueva del mismo servicio, no", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, PRICE);
      const quoteId = await newQuote(w.sales);
      const kept = randomUUID();
      await saveOk(w.sales, quoteId, [{ id: kept, catalogItemId: service }]);
      await replaceHook("select false");
      // la que ya estaba, guardada otra vez: se guarda
      await saveOk(w.sales, quoteId, [{ id: kept, catalogItemId: service }]);
      expect(await revision(quoteId)).toBe(3);
      // agregar otra del mismo servicio: no
      const error = await saveFails(w.sales, quoteId, [
        { id: kept, catalogItemId: service },
        { id: randomUUID(), catalogItemId: service },
      ]);
      expect(error.message).toBe("line_rules_invalid: catalog_item_not_allowed@1");
    }));

  it("una línea libre no pasa por el gancho", () =>
    withTx(db, async () => {
      const quoteId = await newQuote(w.sales);
      await replaceHook("select false");
      await saveOk(w.sales, quoteId, [{ id: randomUUID(), price: 123 }]);
      expect(await revision(quoteId)).toBe(2);
    }));

  it("el gancho recibe el id del servicio: puede decir «no» solo a uno", () =>
    withTx(db, async () => {
      const allowed = await addCatalogItem(db, w.tenantA, PRICE);
      const denied = await addCatalogItem(db, w.tenantA, PRICE);
      const quoteId = await newQuote(w.sales);
      await replaceHook(`select p_catalog_item_id <> '${denied}'::uuid`);
      await saveOk(w.sales, quoteId, [{ id: randomUUID(), catalogItemId: allowed }]);
      const error = await saveFails(w.sales, quoteId, [
        { id: randomUUID(), catalogItemId: allowed },
        { id: randomUUID(), catalogItemId: denied },
      ]);
      expect(error.message).toBe("line_rules_invalid: catalog_item_not_allowed@1");
    }));

  it("el formato de error es el mismo de las otras reglas: los problemas de precio van antes y el del gancho al final", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, PRICE);
      await actAsPostgres(db);
      await db.query("update public.catalog_items set price_locked = true where id = $1", [
        service,
      ]);
      await db.query("update public.tenants set max_discount_bp = 1000 where tenant_id = $1", [
        w.tenantA,
      ]);
      const quoteId = await newQuote(w.sales);
      await replaceHook("select false");
      const error = await saveFails(
        w.sales,
        quoteId,
        [
          { id: randomUUID(), price: 500 },
          { id: randomUUID(), catalogItemId: service },
        ],
        2_000,
      );
      expect(error.message).toBe(
        "line_rules_invalid: discount_over_cap@0,discount_over_cap@1,catalog_item_not_allowed@1",
      );
    }));

  it("el gancho no salta a quien se salta la regla de precios: un Dueño tampoco guarda una línea nueva que el gancho niega", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, PRICE);
      const quoteId = await newQuote(w.owner);
      await replaceHook("select false");
      const error = await saveFails(w.owner, quoteId, [
        { id: randomUUID(), catalogItemId: service },
      ]);
      expect(error.message).toBe("line_rules_invalid: catalog_item_not_allowed@0");
    }));
});

describe("las tres reglas de H-041 siguen vivas dentro de `save_quote_draft`", () => {
  it("price_locked@, discount_over_cap@ y global_discount_over_cap", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, PRICE);
      await actAsPostgres(db);
      await db.query("update public.catalog_items set price_locked = true where id = $1", [
        service,
      ]);
      await db.query("update public.tenants set max_discount_bp = 0 where tenant_id = $1", [
        w.tenantA,
      ]);
      const quoteId = await newQuote(w.sales);
      const priceError = await saveFails(w.sales, quoteId, [
        { id: randomUUID(), catalogItemId: service, price: 1 },
      ]);
      expect(priceError.message).toBe("line_rules_invalid: price_locked@0");
      const discountError = await saveFails(w.sales, quoteId, [{ id: randomUUID() }], 100);
      expect(discountError.message).toBe("line_rules_invalid: discount_over_cap@0");
      // el descuento general se rechaza con una cotización armada a mano (el helper de esta prueba solo trae descuento de línea)
      const rev = await revision(quoteId);
      const calc = calculateQuote({
        lines: [
          {
            quantityMilli: 1000,
            unitPriceClp: PRICE,
            taxTreatment: "taxable",
            discount: { kind: "none" },
          },
        ],
        globalDiscount: { kind: "percent", bp: 100 },
        taxRateBp: 1900,
      });
      if (!calc.ok) throw new Error("cálculo inválido");
      await asUser(db, w.sales, w.tenantA);
      const globalError = await expectSqlError(db, SAVE, [
        quoteId,
        rev,
        randomUUID(),
        JSON.stringify({
          customer_id: w.customerA,
          global_discount: { kind: "percent", value: 100 },
        }),
        JSON.stringify([line({ id: randomUUID(), unit_price_clp: PRICE })]),
        JSON.stringify(calc.totals),
      ]);
      expect(globalError.message).toBe("line_rules_invalid: global_discount_over_cap");
    }));
});

describe("los textos de H-048b siguen vivos junto a las reglas de H-041 y el gancho de H-042", () => {
  it("un guardado con exclusiones y notas pasa por la regla de precios y por el gancho, y los escribe", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, PRICE);
      await actAsPostgres(db);
      await db.query("update public.catalog_items set price_locked = true where id = $1", [
        service,
      ]);
      const quoteId = await newQuote(w.sales);
      const withTexts = (lines: L[]) => {
        const [header, items, totals] = body(lines);
        return [
          JSON.stringify({
            ...JSON.parse(header),
            exclusions: "No incluye embalaje.",
            footer_note: "Valores en pesos chilenos.",
          }),
          items,
          totals,
        ];
      };
      // la regla de precio bloqueado sigue mirando: un precio distinto se rechaza y NO se guarda ningún texto
      const rev = await revision(quoteId);
      await asUser(db, w.sales, w.tenantA);
      const blocked = await expectSqlError(db, SAVE, [
        quoteId,
        rev,
        randomUUID(),
        ...withTexts([{ id: randomUUID(), catalogItemId: service, price: 1 }]),
      ]);
      expect(blocked.message).toBe("line_rules_invalid: price_locked@0");
      await actAsPostgres(db);
      expect(
        (
          await db.query("select exclusions, footer_note from public.quotes where id = $1", [
            quoteId,
          ])
        ).rows[0],
      ).toEqual({ exclusions: null, footer_note: null });
      // el gancho sigue mirando: con «no», una línea nueva del catálogo se rechaza aunque traiga textos
      await replaceHook("select false");
      await asUser(db, w.sales, w.tenantA);
      const denied = await expectSqlError(db, SAVE, [
        quoteId,
        rev,
        randomUUID(),
        ...withTexts([{ id: randomUUID(), catalogItemId: service }]),
      ]);
      expect(denied.message).toBe("line_rules_invalid: catalog_item_not_allowed@0");
      // con todo en regla, se guardan los textos
      await actAsPostgres(db);
      await replaceHook("select true");
      await asUser(db, w.sales, w.tenantA);
      await db.query(SAVE, [
        quoteId,
        rev,
        randomUUID(),
        ...withTexts([{ id: randomUUID(), catalogItemId: service }]),
      ]);
      await actAsPostgres(db);
      expect(
        (
          await db.query("select exclusions, footer_note from public.quotes where id = $1", [
            quoteId,
          ])
        ).rows[0],
      ).toEqual({ exclusions: "No incluye embalaje.", footer_note: "Valores en pesos chilenos." });
    }));
});
