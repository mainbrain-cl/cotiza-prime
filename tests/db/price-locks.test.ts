// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · H-041 etapa A · migración 20261118100000 · precios bloqueados y tope de descuento en la base de datos.
// Cubre: el Comercial que habla directo con `save_quote_draft` (precio bloqueado, descuento de línea y general sobre el tope: CP422 y
// revisión intacta); la regla y sus bordes (10,00 % pasa, 10,01 % no; $101 sobre $1.005; tope 0; sin tope; el precio bloqueado SÍ admite
// descuento); el borrador guardado antes del candado; Dueño y Administrador cambian un precio bloqueado (un evento y una auditoría solo
// si cambió de verdad; la misma `save_id` no duplica; a lo más 20 líneas y sin nombres); el envío (tope bajado o candado puesto después
// de guardar, dos reglas violadas a la vez, Administrador bajado a Comercial; sin paquete, enlace, correo ni candado a medias); lo ya
// enviado no cambia y el reenvío funciona; el orden de los disparadores; `set_quote_max_discount` (roles, rango, auditoría, repetido no
// audita); escritura directa de `max_discount_bp` rechazada; y que el candado y el tope se leen siempre por (organización, id).
// La prueba crea SUS PROPIOS servicios de catálogo: no usa los de la semilla.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateQuote, type Discount } from "../../src/lib/quotes/calc";
import { actAsPostgres, connect, expectSqlError, withTx, type TestUser } from "./helpers";
import {
  PREPARE_SQL,
  addCatalogItem,
  prepareArgs,
  prepareIds,
  sendFootprint,
} from "./approval-helpers";
import { asUser, buildWorld, line, sha256Hex, type World } from "./send-helpers";

let db: Client;
let w: World;
beforeAll(async () => {
  db = await connect();
  w = await buildWorld(db);
});
afterAll(async () => {
  await db.end();
});

const CATALOG = 10_000;
const SAVE = "select public.save_quote_draft($1, $2, $3, $4, $5, $6) as r";
const RULES_PREFIX = "line_rules_invalid: ";

type Item = {
  id?: string;
  catalogItemId?: string;
  price: number;
  qtyMilli?: number;
  discount?: Discount;
  name?: string;
};

const toDb = (d: Discount | undefined) =>
  !d || d.kind === "none"
    ? { kind: "none", value: 0 }
    : d.kind === "percent"
      ? { kind: "percent", value: d.bp }
      : { kind: "amount", value: d.clp };

async function lockService(id: string) {
  await actAsPostgres(db);
  await db.query("update public.catalog_items set price_locked = true where id = $1", [id]);
}
async function unlockService(id: string) {
  await actAsPostgres(db);
  await db.query("update public.catalog_items set price_locked = false where id = $1", [id]);
}
async function setCap(tenant: string, bp: number | null) {
  await actAsPostgres(db);
  await db.query("update public.tenants set max_discount_bp = $2 where tenant_id = $1", [
    tenant,
    bp,
  ]);
}
/** Como el dueño de la base de datos y SIN sesión de persona (`actAsPostgres` deja los pases de la última persona puestos). */
async function withoutSession() {
  await db.query("reset role");
  await db.query(`select set_config('request.jwt.claims', '', true)`);
  await db.query(`select set_config('request.jwt.claim.sub', '', true)`);
  await db.query(`select set_config('request.headers', '{}', true)`);
}
async function revisionOf(quoteId: string): Promise<number> {
  await actAsPostgres(db);
  const { rows } = await db.query<{ revision: number }>(
    "select revision from public.quotes where id = $1",
    [quoteId],
  );
  return rows[0].revision;
}
/** Una cotización vacía del usuario (revisión 1). */
async function newQuote(user: TestUser, tenant = w.tenantA, customer = w.customerA) {
  await asUser(db, user, tenant);
  const { rows } = await db.query<{ quote_id: string }>(
    "select * from public.create_quote($1, $2)",
    [customer, randomUUID()],
  );
  await actAsPostgres(db);
  return rows[0].quote_id;
}

/** El cuerpo de una llamada a `save_quote_draft` con los totales que calcula la aplicación. */
function payload(items: Item[], global?: Discount) {
  const withIds = items.map((i) => ({ ...i, id: i.id ?? randomUUID() }));
  const calc = calculateQuote({
    lines: withIds.map((i) => ({
      quantityMilli: i.qtyMilli ?? 1000,
      unitPriceClp: i.price,
      taxTreatment: "taxable" as const,
      discount: i.discount ?? { kind: "none" as const },
    })),
    globalDiscount: global ?? { kind: "none" },
    taxRateBp: 1900,
  });
  if (!calc.ok) throw new Error(`cálculo de prueba inválido: ${JSON.stringify(calc.issues)}`);
  const g = toDb(global);
  return {
    items: withIds,
    header: JSON.stringify({
      customer_id: w.customerA,
      global_discount: { kind: g.kind, value: g.value },
    }),
    lines: JSON.stringify(
      withIds.map((i) => {
        const d = toDb(i.discount);
        return line({
          id: i.id,
          name: i.name ?? "Servicio",
          unit_price_clp: i.price,
          quantity_milli: i.qtyMilli ?? 1000,
          discount_kind: d.kind,
          discount_value: d.value,
          ...(i.catalogItemId ? { catalog_item_id: i.catalogItemId } : {}),
        });
      }),
    ),
    totals: JSON.stringify(calc.totals),
  };
}

/** Guarda como `user` (la prueba espera que funcione); la revisión esperada es la de ahora. */
async function save(
  user: TestUser,
  quoteId: string,
  items: Item[],
  options: { global?: Discount; tenant?: string } = {},
) {
  const revision = await revisionOf(quoteId);
  const p = payload(items, options.global);
  await asUser(db, user, options.tenant ?? w.tenantA);
  const { rows } = await db.query<{ r: Record<string, unknown> }>(SAVE, [
    quoteId,
    revision,
    randomUUID(),
    p.header,
    p.lines,
    p.totals,
  ]);
  await actAsPostgres(db);
  return { result: rows[0].r, items: p.items };
}

/** Intenta guardar y devuelve el error (la prueba espera uno); deja la transacción sana con un savepoint. */
async function saveFails(
  user: TestUser,
  quoteId: string,
  items: Item[],
  options: { global?: Discount; tenant?: string } = {},
) {
  const revision = await revisionOf(quoteId);
  const p = payload(items, options.global);
  await asUser(db, user, options.tenant ?? w.tenantA);
  const error = await expectSqlError(db, SAVE, [
    quoteId,
    revision,
    randomUUID(),
    p.header,
    p.lines,
    p.totals,
  ]);
  await actAsPostgres(db);
  return error;
}

async function events(quoteId: string, type = "locked_price_overridden") {
  await actAsPostgres(db);
  const { rows } = await db.query<{ data: Record<string, unknown> }>(
    "select data from public.quote_events where quote_id = $1 and type = $2 order by id",
    [quoteId, type],
  );
  return rows.map((r) => r.data);
}
async function auditCount(quoteId: string, action = "quote.locked_price_overridden") {
  await actAsPostgres(db);
  const { rows } = await db.query<{ n: string }>(
    "select count(*) as n from public.audit_log where resource_id = $1 and action = $2",
    [quoteId, action],
  );
  return Number(rows[0].n);
}
/** Cuántas veces se guardó (revisión) y cuántas líneas hay. */
async function stored(quoteId: string) {
  await actAsPostgres(db);
  const { rows } = await db.query<{ revision: number; lines: string }>(
    `select q.revision, (select count(*) from public.quote_items i where i.quote_id = q.id) as lines
       from public.quotes q where q.id = $1`,
    [quoteId],
  );
  return { revision: rows[0].revision, lines: Number(rows[0].lines) };
}

describe("el Comercial habla directo con `save_quote_draft`", () => {
  it("precio bloqueado a otro precio (más bajo o más alto): CP422 y no se guarda nada", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      await lockService(service);
      const quoteId = await newQuote(w.sales);
      // línea nueva con el precio de catálogo: pasa
      const ok = await save(w.sales, quoteId, [{ catalogItemId: service, price: CATALOG }]);
      expect(ok.result.revision).toBe(2);
      for (const price of [8_000, 12_000, 1]) {
        const error = await saveFails(w.sales, quoteId, [{ catalogItemId: service, price }]);
        expect(error.code).toBe("CP422");
        expect(error.message).toBe(`${RULES_PREFIX}price_locked@0`);
      }
      // revisión intacta
      expect(await stored(quoteId)).toEqual({ revision: 2, lines: 1 });
      await actAsPostgres(db);
      const { rows } = await db.query(
        "select unit_price_clp from public.quote_items where quote_id = $1",
        [quoteId],
      );
      expect(Number(rows[0].unit_price_clp)).toBe(CATALOG);
    }));

  it("una línea NUEVA con precio distinto en un servicio bloqueado se rechaza, y una libre con precio propio se acepta", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      await lockService(service);
      const quoteId = await newQuote(w.sales);
      const error = await saveFails(w.sales, quoteId, [
        { price: 777 },
        { catalogItemId: service, price: 9_999 },
      ]);
      expect(error.message).toBe(`${RULES_PREFIX}price_locked@1`);
      // la línea libre sola, a otro precio, se guarda (el hueco de la pregunta 18, documentado)
      const free = await save(w.sales, quoteId, [{ price: 777 }]);
      expect(free.result.revision).toBe(2);
    }));

  it("un servicio sin candado se cotiza a cualquier precio (sin tope también cualquier descuento)", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      const quoteId = await newQuote(w.sales);
      const ok = await save(
        w.sales,
        quoteId,
        [{ catalogItemId: service, price: 5_000, discount: { kind: "percent", bp: 9_000 } }],
        { global: { kind: "percent", bp: 9_000 } },
      );
      expect(ok.result.revision).toBe(2);
    }));

  it("descuento de línea y general sobre el tope: CP422 con el índice desde 0, y no se guarda nada", () =>
    withTx(db, async () => {
      await setCap(w.tenantA, 1_000);
      const quoteId = await newQuote(w.sales);
      const lineError = await saveFails(w.sales, quoteId, [
        { price: CATALOG },
        { price: CATALOG, discount: { kind: "percent", bp: 1_500 } },
      ]);
      expect(lineError.code).toBe("CP422");
      expect(lineError.message).toBe(`${RULES_PREFIX}discount_over_cap@1`);
      const globalError = await saveFails(w.sales, quoteId, [{ price: CATALOG }], {
        global: { kind: "percent", bp: 1_500 },
      });
      expect(globalError.message).toBe(`${RULES_PREFIX}global_discount_over_cap`);
      const amountError = await saveFails(w.sales, quoteId, [{ price: CATALOG }], {
        global: { kind: "amount", clp: 1_001 },
      });
      expect(amountError.message).toBe(`${RULES_PREFIX}global_discount_over_cap`);
      expect(await stored(quoteId)).toEqual({ revision: 1, lines: 0 });
    }));

  it("el tope exacto pasa y un poquito más no; en pesos sobre $1.005 al 10 % son $101", () =>
    withTx(db, async () => {
      await setCap(w.tenantA, 1_000);
      const quoteId = await newQuote(w.sales);
      expect(
        (
          await save(w.sales, quoteId, [
            { price: CATALOG, discount: { kind: "percent", bp: 1_000 } },
          ])
        ).result.revision,
      ).toBe(2);
      expect(
        (
          await saveFails(w.sales, quoteId, [
            { price: CATALOG, discount: { kind: "percent", bp: 1_001 } },
          ])
        ).message,
      ).toBe(`${RULES_PREFIX}discount_over_cap@0`);
      expect(
        (await save(w.sales, quoteId, [{ price: 1_005, discount: { kind: "amount", clp: 101 } }]))
          .result.revision,
      ).toBe(3);
      expect(
        (
          await saveFails(w.sales, quoteId, [
            { price: 1_005, discount: { kind: "amount", clp: 102 } },
          ])
        ).message,
      ).toBe(`${RULES_PREFIX}discount_over_cap@0`);
    }));

  it("tope 0: ningún descuento; vacío: sin tope", () =>
    withTx(db, async () => {
      await setCap(w.tenantA, 0);
      const quoteId = await newQuote(w.sales);
      expect(
        (
          await saveFails(w.sales, quoteId, [
            { price: CATALOG, discount: { kind: "amount", clp: 1 } },
          ])
        ).message,
      ).toBe(`${RULES_PREFIX}discount_over_cap@0`);
      expect((await save(w.sales, quoteId, [{ price: CATALOG }])).result.revision).toBe(2);
      await setCap(w.tenantA, null);
      expect(
        (
          await save(w.sales, quoteId, [
            { price: CATALOG, discount: { kind: "percent", bp: 9_999 } },
          ])
        ).result.revision,
      ).toBe(3);
    }));

  it("un precio bloqueado SÍ admite descuento hasta el tope (pregunta 19); pasado el tope, no", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      await lockService(service);
      await setCap(w.tenantA, 1_000);
      const quoteId = await newQuote(w.sales);
      expect(
        (
          await save(w.sales, quoteId, [
            { catalogItemId: service, price: CATALOG, discount: { kind: "percent", bp: 1_000 } },
          ])
        ).result.revision,
      ).toBe(2);
      expect(
        (
          await saveFails(w.sales, quoteId, [
            { catalogItemId: service, price: CATALOG, discount: { kind: "percent", bp: 1_100 } },
          ])
        ).message,
      ).toBe(`${RULES_PREFIX}discount_over_cap@0`);
    }));

  it("solo cuentan los campos de descuento: bajar el precio de una línea SIN candado no cuenta contra el tope (pregunta 19)", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      await setCap(w.tenantA, 0);
      const quoteId = await newQuote(w.sales);
      expect(
        (await save(w.sales, quoteId, [{ catalogItemId: service, price: 4_000 }])).result.revision,
      ).toBe(2);
    }));

  it("varios problemas: salen todos, en orden (por línea, y al final el general), con el índice desde 0", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      await lockService(service);
      await setCap(w.tenantA, 1_000);
      const quoteId = await newQuote(w.sales);
      const error = await saveFails(
        w.sales,
        quoteId,
        [
          { catalogItemId: service, price: 5_000 },
          { price: CATALOG },
          {
            catalogItemId: service,
            price: 7_000,
            discount: { kind: "percent", bp: 5_000 },
          },
        ],
        { global: { kind: "percent", bp: 5_000 } },
      );
      expect(error.message).toBe(
        `${RULES_PREFIX}price_locked@0,price_locked@2,discount_over_cap@2,global_discount_over_cap`,
      );
    }));

  it("la regla de OTRA organización no se aplica aquí (cada una tiene su tope)", () =>
    withTx(db, async () => {
      await setCap(w.tenantB, 0);
      const quoteId = await newQuote(w.sales);
      expect(
        (
          await save(w.sales, quoteId, [
            { price: CATALOG, discount: { kind: "percent", bp: 5_000 } },
          ])
        ).result.revision,
      ).toBe(2);
    }));
});

describe("el borrador guardado antes del candado", () => {
  it("al guardar de nuevo se rechaza (price_locked) y al enviar también; con el precio de catálogo vuelve a pasar", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      const quoteId = await newQuote(w.sales);
      const first = await save(w.sales, quoteId, [{ catalogItemId: service, price: 8_000 }]);
      await lockService(service);
      const again = await saveFails(w.sales, quoteId, [
        { id: first.items[0].id, catalogItemId: service, price: 8_000 },
      ]);
      expect(again.message).toBe(`${RULES_PREFIX}price_locked@0`);

      // al enviar: el disparador mira las líneas guardadas
      const revision = await revisionOf(quoteId);
      const ids = prepareIds();
      await asUser(db, w.sales, w.tenantA);
      const send = await expectSqlError(db, PREPARE_SQL, prepareArgs(quoteId, revision, ids));
      expect(send.code).toBe("CP422");
      expect(send.message).toBe(`${RULES_PREFIX}price_locked@0`);
      expect(await sendFootprint(db, w.tenantA, quoteId)).toEqual({
        packages: 0,
        links: 0,
        emails: 0,
        locked: false,
      });

      // volver al precio del catálogo lo arregla
      const fixed = await save(w.sales, quoteId, [
        { id: first.items[0].id, catalogItemId: service, price: CATALOG },
      ]);
      expect(fixed.result.revision).toBe(3);
    }));

  it("quitar el candado libera también las líneas ya guardadas (el candado no se copia a la línea)", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      const quoteId = await newQuote(w.sales);
      const first = await save(w.sales, quoteId, [{ catalogItemId: service, price: 8_000 }]);
      await lockService(service);
      await saveFails(w.sales, quoteId, [
        { id: first.items[0].id, catalogItemId: service, price: 8_000 },
      ]);
      await unlockService(service);
      const ok = await save(w.sales, quoteId, [
        { id: first.items[0].id, catalogItemId: service, price: 8_000 },
      ]);
      expect(ok.result.revision).toBe(3);
      await actAsPostgres(db);
      const { rows } = await db.query(
        "select 1 from information_schema.columns where table_name = 'quote_items' and column_name = 'price_locked'",
      );
      expect(rows).toHaveLength(0);
    }));

  it("el candado se mira aunque el servicio esté desactivado hoy", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      const quoteId = await newQuote(w.sales);
      const first = await save(w.sales, quoteId, [{ catalogItemId: service, price: 8_000 }]);
      await lockService(service);
      await actAsPostgres(db);
      await db.query("update public.catalog_items set is_active = false where id = $1", [service]);
      const error = await saveFails(w.sales, quoteId, [
        { id: first.items[0].id, catalogItemId: service, price: 8_000 },
      ]);
      expect(error.message).toBe(`${RULES_PREFIX}price_locked@0`);
    }));
});

describe("Dueño y Administrador cambian un precio bloqueado", () => {
  for (const [label, user] of [
    ["el Dueño", () => w.owner],
    ["el Administrador", () => w.admin],
  ] as const) {
    it(`${label}: se guarda, y queda UN evento y UNA auditoría solo cuando el precio cambió de verdad`, () =>
      withTx(db, async () => {
        const service = await addCatalogItem(db, w.tenantA, CATALOG, "Servicio secreto XYZ");
        await lockService(service);
        const quoteId = await newQuote(user());
        // línea nueva con otro precio: cambio real (no tenía precio anterior)
        const first = await save(user(), quoteId, [
          { catalogItemId: service, price: 8_000, name: "Nombre de línea reservado" },
        ]);
        expect(first.result.revision).toBe(2);
        let evs = await events(quoteId);
        expect(evs).toHaveLength(1);
        expect(evs[0]).toMatchObject({
          count: 1,
          lines: [
            {
              position: 1,
              catalog_item_id: service,
              old_price_clp: null,
              new_price_clp: 8_000,
            },
          ],
        });
        expect(await auditCount(quoteId)).toBe(1);

        // guardar de nuevo el MISMO precio (otra save_id, otra revisión): no hay cambio real → nada nuevo
        await save(user(), quoteId, [
          { id: first.items[0].id, catalogItemId: service, price: 8_000 },
        ]);
        expect(await events(quoteId)).toHaveLength(1);
        expect(await auditCount(quoteId)).toBe(1);

        // cambiarlo a otro precio: segundo evento con el precio anterior
        await save(user(), quoteId, [
          { id: first.items[0].id, catalogItemId: service, price: 7_000 },
        ]);
        evs = await events(quoteId);
        expect(evs).toHaveLength(2);
        expect(evs[1]).toMatchObject({
          lines: [{ position: 1, old_price_clp: 8_000, new_price_clp: 7_000 }],
        });
        expect(await auditCount(quoteId)).toBe(2);

        // volver al precio del catálogo: ya no se salta nada → ningún evento nuevo
        await save(user(), quoteId, [
          { id: first.items[0].id, catalogItemId: service, price: CATALOG },
        ]);
        expect(await events(quoteId)).toHaveLength(2);

        // ni el evento ni la auditoría llevan nombres de línea ni del servicio
        await actAsPostgres(db);
        const { rows } = await db.query(
          `select (select string_agg(data::text, '|') from public.quote_events where quote_id = $1) as e,
                  (select string_agg(details::text, '|') from public.audit_log
                    where resource_id = $1 and action = 'quote.locked_price_overridden') as a`,
          [quoteId],
        );
        for (const text of [rows[0].e, rows[0].a] as string[]) {
          expect(text).not.toContain("Nombre de línea reservado");
          expect(text).not.toContain("Servicio secreto XYZ");
        }
      }));
  }

  it("la misma `save_id` otra vez (reintento) no duplica el evento ni la auditoría", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      await lockService(service);
      const quoteId = await newQuote(w.admin);
      const saveId = randomUUID();
      const items: Item[] = [{ id: randomUUID(), catalogItemId: service, price: 6_000 }];
      const revision = await revisionOf(quoteId);
      const p = payload(items);
      await asUser(db, w.admin, w.tenantA);
      await db.query(SAVE, [quoteId, revision, saveId, p.header, p.lines, p.totals]);
      const replay = await db.query<{ r: { replayed?: boolean } }>(SAVE, [
        quoteId,
        revision,
        saveId,
        p.header,
        p.lines,
        p.totals,
      ]);
      expect(replay.rows[0].r.replayed).toBe(true);
      expect(await events(quoteId)).toHaveLength(1);
      expect(await auditCount(quoteId)).toBe(1);
    }));

  it("un servicio sin candado cambiado de precio, o un precio igual al del catálogo, no deja evento", () =>
    withTx(db, async () => {
      const free = await addCatalogItem(db, w.tenantA, CATALOG);
      const locked = await addCatalogItem(db, w.tenantA, CATALOG);
      await lockService(locked);
      const quoteId = await newQuote(w.owner);
      await save(w.owner, quoteId, [
        { catalogItemId: free, price: 1_000 },
        { catalogItemId: locked, price: CATALOG },
        { price: 3 },
      ]);
      expect(await events(quoteId)).toHaveLength(0);
      expect(await auditCount(quoteId)).toBe(0);
    }));

  it("con 25 líneas cambiadas el evento lleva el total (25) pero solo 20 líneas, y cabe en su límite", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      await lockService(service);
      const quoteId = await newQuote(w.owner);
      await save(
        w.owner,
        quoteId,
        Array.from({ length: 25 }, (_, n) => ({ catalogItemId: service, price: 100 + n })),
      );
      const evs = await events(quoteId);
      expect(evs).toHaveLength(1);
      expect(evs[0].count).toBe(25);
      expect((evs[0].lines as unknown[]).length).toBe(20);
      expect((evs[0].lines as { position: number }[])[19].position).toBe(20);
      expect(await auditCount(quoteId)).toBe(1);
    }));

  it("el peor caso de tamaño (20 servicios distintos, 20 posiciones, montos de 12 cifras) cabe en el límite del evento (4.096 bytes)", () =>
    withTx(db, async () => {
      // 20 servicios DISTINTOS (20 identificadores distintos: nada que comprimir) y 20 posiciones distintas
      const services: string[] = [];
      for (let n = 0; n < 20; n += 1) {
        const service = await addCatalogItem(db, w.tenantA, 999_999_999_999);
        await lockService(service);
        services.push(service);
      }
      const quoteId = await newQuote(w.owner);
      // dos guardados: el primero deja precios altos; el segundo los cambia a otros altos (old y new de 12 cifras)
      const ids = services.map(() => randomUUID());
      await save(
        w.owner,
        quoteId,
        ids.map((id, n) => ({
          id,
          catalogItemId: services[n],
          price: 999_999_999_998,
          qtyMilli: 1,
        })),
      );
      await save(
        w.owner,
        quoteId,
        ids.map((id, n) => ({
          id,
          catalogItemId: services[n],
          price: 999_999_999_997,
          qtyMilli: 1,
        })),
      );
      const evs = await events(quoteId);
      expect(evs).toHaveLength(2);
      expect((evs[1].lines as unknown[]).length).toBe(20);
      await actAsPostgres(db);
      // el largo del texto (sin compresión) es la medida honesta; la restricción mide `pg_column_size`, que es menor o igual
      const { rows } = await db.query<{ size: number }>(
        "select max(octet_length(data::text)) as size from public.quote_events where quote_id = $1",
        [quoteId],
      );
      expect(rows[0].size).toBeLessThanOrEqual(4096);
    }));

  it("el evento y la auditoría guardan el precio como entero aunque llegue con ceros decimales (8000.0000)", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      await lockService(service);
      const quoteId = await newQuote(w.owner);
      const p = payload([{ catalogItemId: service, price: 8_000 }]);
      const lines = p.lines.replace(/"unit_price_clp":8000(?=[,}])/, '"unit_price_clp":8000.0000');
      expect(lines).not.toBe(p.lines);
      const revision = await revisionOf(quoteId);
      await asUser(db, w.owner, w.tenantA);
      await db.query(SAVE, [quoteId, revision, randomUUID(), p.header, lines, p.totals]);
      await actAsPostgres(db);
      const { rows } = await db.query<{ e: string; a: string }>(
        `select (select data::text from public.quote_events where quote_id = $1 and type = 'locked_price_overridden') as e,
                (select details::text from public.audit_log
                  where resource_id = $1 and action = 'quote.locked_price_overridden') as a`,
        [quoteId],
      );
      for (const text of [rows[0].e, rows[0].a]) {
        expect(text).toContain('"new_price_clp": 8000,');
        expect(text).not.toContain("8000.0000");
      }
    }));

  it("Dueño y Administrador se saltan el tope (con tope 0 guardan descuento) y eso no deja evento", () =>
    withTx(db, async () => {
      await setCap(w.tenantA, 0);
      const quoteId = await newQuote(w.admin);
      const ok = await save(w.admin, quoteId, [
        { price: CATALOG, discount: { kind: "percent", bp: 5_000 } },
      ]);
      expect(ok.result.revision).toBe(2);
      // pero sin tocar un precio bloqueado, no dejan evento
      expect(await events(quoteId)).toHaveLength(0);
    }));
});

describe("al enviar", () => {
  async function prepareAs(user: TestUser, quoteId: string) {
    const revision = await revisionOf(quoteId);
    const ids = prepareIds();
    await asUser(db, user, w.tenantA);
    const { rows } = await db.query<{ r: { status: string } }>(
      PREPARE_SQL,
      prepareArgs(quoteId, revision, ids),
    );
    await actAsPostgres(db);
    return rows[0].r;
  }
  async function prepareFails(user: TestUser, quoteId: string) {
    const revision = await revisionOf(quoteId);
    await asUser(db, user, w.tenantA);
    const error = await expectSqlError(
      db,
      PREPARE_SQL,
      prepareArgs(quoteId, revision, prepareIds()),
    );
    await actAsPostgres(db);
    return error;
  }
  const EMPTY = { packages: 0, links: 0, emails: 0, locked: false };

  it("el tope bajado DESPUÉS de guardar se aplica al enviar: CP422 y sin paquete, enlace, correo ni candado", () =>
    withTx(db, async () => {
      const quoteId = await newQuote(w.sales);
      await save(w.sales, quoteId, [{ price: CATALOG, discount: { kind: "percent", bp: 2_000 } }]);
      await setCap(w.tenantA, 1_000);
      const error = await prepareFails(w.sales, quoteId);
      expect(error.code).toBe("CP422");
      expect(error.message).toBe(`${RULES_PREFIX}discount_over_cap@0`);
      expect(await sendFootprint(db, w.tenantA, quoteId)).toEqual(EMPTY);
      // con el tope de antes (o subido) sale
      await setCap(w.tenantA, 2_000);
      expect((await prepareAs(w.sales, quoteId)).status).toBe("prepared");
    }));

  it("el descuento general sobre el tope también se detiene al enviar", () =>
    withTx(db, async () => {
      const quoteId = await newQuote(w.sales);
      await save(w.sales, quoteId, [{ price: CATALOG }], {
        global: { kind: "percent", bp: 3_000 },
      });
      await setCap(w.tenantA, 1_000);
      expect((await prepareFails(w.sales, quoteId)).message).toBe(
        `${RULES_PREFIX}global_discount_over_cap`,
      );
      expect(await sendFootprint(db, w.tenantA, quoteId)).toEqual(EMPTY);
    }));

  it("dos reglas violadas a la vez (tope duro y aprobación): gana `line_rules_invalid`, no `approval_required`", () =>
    withTx(db, async () => {
      const quoteId = await newQuote(w.sales);
      await save(w.sales, quoteId, [
        { price: 1_000_000, discount: { kind: "percent", bp: 2_000 } },
      ]);
      await setCap(w.tenantA, 1_000);
      // la aprobación «Siempre»
      await asUser(db, w.owner, w.tenantA);
      await db.query("select public.set_approval_rule(1, 'always', null, null)");
      await actAsPostgres(db);
      const error = await prepareFails(w.sales, quoteId);
      expect(error.code).toBe("CP422");
      expect(error.message).toBe(`${RULES_PREFIX}discount_over_cap@0`);
    }));

  it("la regla de aprobación sigue mandando cuando el tope se cumple (no se tapa una con la otra)", () =>
    withTx(db, async () => {
      const quoteId = await newQuote(w.sales);
      await save(w.sales, quoteId, [{ price: CATALOG }]);
      await asUser(db, w.owner, w.tenantA);
      await db.query("select public.set_approval_rule(1, 'always', null, null)");
      await actAsPostgres(db);
      const error = await prepareFails(w.sales, quoteId);
      expect(error.code).toBe("CP423");
      expect(error.message).toBe("approval_required");
    }));

  it("un Administrador bajado a Comercial entre guardar y enviar queda sujeto a la regla", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      await lockService(service);
      const quoteId = await newQuote(w.admin);
      await save(w.admin, quoteId, [{ catalogItemId: service, price: 6_000 }]);
      // como Administrador, sale
      await actAsPostgres(db);
      await db.query(
        "update public.members set role = 'sales' where tenant_id = $1 and user_id = $2",
        [w.tenantA, w.admin.id],
      );
      const error = await prepareFails(w.admin, quoteId);
      expect(error.message).toBe(`${RULES_PREFIX}price_locked@0`);
      expect(await sendFootprint(db, w.tenantA, quoteId)).toEqual(EMPTY);
    }));

  it("el Dueño y el Administrador envían una cotización con precio bloqueado cambiado", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      await lockService(service);
      await setCap(w.tenantA, 0);
      for (const user of [w.owner, w.admin]) {
        const quoteId = await newQuote(user);
        await save(user, quoteId, [
          { catalogItemId: service, price: 6_000, discount: { kind: "percent", bp: 3_000 } },
        ]);
        expect((await prepareAs(user, quoteId)).status).toBe("prepared");
      }
    }));

  it("la cotización de otra organización no se evalúa: la relación compuesta rechaza la fila (23503)", () =>
    withTx(db, async () => {
      const quoteId = await newQuote(w.sales);
      await actAsPostgres(db);
      const error = await expectSqlError(
        db,
        `insert into public.quote_packages
           (id, tenant_id, quote_id, send_key, issue_date, valid_until, email_subject, email_body_md,
            customer_snapshot_enc, created_by)
         values ($1, $2, $3, $4, app.current_business_date(), app.current_business_date() + 10, 's', 'b', 'v1.x.y', $5)`,
        [randomUUID(), w.tenantB, quoteId, randomUUID(), w.ownerB.id],
      );
      expect(error.code).toBe("23503");
    }));

  it("un paquete insertado sin sesión de persona (nadie se salta la regla) se rechaza igual", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      const quoteId = await newQuote(w.owner);
      await save(w.owner, quoteId, [{ catalogItemId: service, price: 6_000 }]);
      await lockService(service);
      await withoutSession();
      const error = await expectSqlError(
        db,
        `insert into public.quote_packages
           (id, tenant_id, quote_id, send_key, issue_date, valid_until, email_subject, email_body_md,
            customer_snapshot_enc, created_by)
         values ($1, $2, $3, $4, app.current_business_date(), app.current_business_date() + 10, 's', 'b', 'v1.x.y', $5)`,
        [randomUUID(), w.tenantA, quoteId, randomUUID(), w.owner.id],
      );
      expect(error.message).toBe(`${RULES_PREFIX}price_locked@0`);
    }));

  it("el disparador de la regla va ANTES que el de aprobación (orden alfabético de PostgreSQL)", async () => {
    await actAsPostgres(db);
    const { rows } = await db.query<{ tgname: string }>(
      `select tgname from pg_trigger
        where tgrelid = 'public.quote_packages'::regclass and not tgisinternal
          and (tgtype & 2) = 2 and (tgtype & 4) = 4 and (tgtype & 1) = 1
        order by tgname`,
    );
    const names = rows.map((r) => r.tgname);
    expect(names.indexOf("quote_packages_a_line_rules_gate")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("quote_packages_a_line_rules_gate")).toBeLessThan(
      names.indexOf("quote_packages_approval_gate"),
    );
    expect(names[0]).toBe("quote_packages_a_line_rules_gate");
  });
});

describe("lo ya enviado no cambia y el reenvío funciona", () => {
  it("cambiar el tope y poner un candado después de enviar no toca lo enviado, y reenviar sigue funcionando", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      const quoteId = await newQuote(w.sales);
      await save(w.sales, quoteId, [
        { catalogItemId: service, price: 7_000, discount: { kind: "percent", bp: 3_000 } },
      ]);
      // se envía de punta a punta por las funciones reales (sin tope y sin candado todavía)
      const revision = await revisionOf(quoteId);
      const ids = prepareIds();
      await asUser(db, w.sales, w.tenantA);
      await db.query(PREPARE_SQL, prepareArgs(quoteId, revision, ids));
      await actAsPostgres(db);
      const pdfPath = `${w.tenantA}/${quoteId}/${ids.packageId}.pdf`;
      await db.query(
        "insert into storage.objects (bucket_id, name, metadata) values ('quote-documents', $1, $2::jsonb)",
        [pdfPath, JSON.stringify({ size: 1234 })],
      );
      await asUser(db, w.sales, w.tenantA);
      await db.query(
        "select public.attach_quote_package_document($1, $2, $3, $4, $5, $6::jsonb, $7, $8)",
        [
          ids.packageId,
          pdfPath,
          sha256Hex("pdf"),
          1234,
          null,
          JSON.stringify({
            organization: { name: "Negocio Ficticio", detailLines: ["contacto@ejemplo.test"] },
            quote: { number: "COT-0001" },
          }),
          sha256Hex(`contenido-${ids.packageId}`),
          ids.sha,
        ],
      );
      await db.query("select public.confirm_email_dispatch($1, 'memory', $2, $3)", [
        ids.emailId,
        `prov-${ids.emailId}`,
        ids.sha,
      ]);

      const fingerprint = async () => {
        await actAsPostgres(db);
        const { rows } = await db.query<{ h: string }>(
          `select md5(
             coalesce((select string_agg(t::text, '|' order by t::text) from public.quotes t where t.id = $1), '') ||
             coalesce((select string_agg(t::text, '|' order by t::text) from public.quote_items t where t.quote_id = $1), '') ||
             coalesce((select string_agg(t::text, '|' order by t::text) from public.quote_packages t where t.quote_id = $1), '')
           ) as h`,
          [quoteId],
        );
        return rows[0].h;
      };
      const before = await fingerprint();
      await setCap(w.tenantA, 0);
      await lockService(service);
      expect(await fingerprint()).toBe(before);

      // el reenvío (otro destinatario) no vuelve a evaluar la regla
      await asUser(db, w.sales, w.tenantA);
      const { rows } = await db.query<{ r: { status: string } }>(
        "select public.prepare_quote_resend($1, $2, $3, $4, $5, $6, $7) as r",
        [
          quoteId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          prepareIds().sha,
          "v1.to.to",
          sha256Hex("otro@ejemplo.test"),
        ],
      );
      expect(rows[0].r.status).toBe("prepared");
    }));
});

describe("`set_quote_max_discount`", () => {
  const SET = "select public.set_quote_max_discount($1) as r";
  async function setAs(user: TestUser, value: number | null, tenant = w.tenantA) {
    await asUser(db, user, tenant);
    const { rows } = await db.query<{ r: { changed: boolean; max_discount_bp: number | null } }>(
      SET,
      [value],
    );
    await actAsPostgres(db);
    return rows[0].r;
  }
  async function capOf(tenant: string) {
    await actAsPostgres(db);
    const { rows } = await db.query<{ v: number | null }>(
      "select max_discount_bp as v from public.tenants where tenant_id = $1",
      [tenant],
    );
    return rows[0].v;
  }
  async function capAudits(tenant: string) {
    await actAsPostgres(db);
    const { rows } = await db.query<{
      details: { old: Record<string, unknown>; new: Record<string, unknown> };
    }>(
      `select details from public.audit_log
        where tenant_id = $1 and action = 'tenant.updated' and details -> 'new' ? 'max_discount_bp'
        order by id`,
      [tenant],
    );
    return rows.map((r) => r.details);
  }

  it("el Dueño y el Administrador lo fijan, lo cambian y lo vacían", () =>
    withTx(db, async () => {
      expect(await capOf(w.tenantA)).toBeNull();
      expect(await setAs(w.owner, 1_000)).toEqual({ changed: true, max_discount_bp: 1_000 });
      expect(await capOf(w.tenantA)).toBe(1_000);
      expect(await setAs(w.admin, 0)).toEqual({ changed: true, max_discount_bp: 0 });
      expect(await setAs(w.owner, 9_999)).toEqual({ changed: true, max_discount_bp: 9_999 });
      expect(await setAs(w.admin, null)).toEqual({ changed: true, max_discount_bp: null });
      expect(await capOf(w.tenantA)).toBeNull();
    }));

  it("Comercial, Aprobador y Observador no pueden (42501) y no se cambia nada", () =>
    withTx(db, async () => {
      for (const user of [w.sales, w.sales2, w.approver, w.viewer]) {
        await asUser(db, user, w.tenantA);
        const error = await expectSqlError(db, SET, [500]);
        expect(error.code, user.id).toBe("42501");
      }
      expect(await capOf(w.tenantA)).toBeNull();
      expect(await capAudits(w.tenantA)).toHaveLength(0);
    }));

  it("quien no es miembro de la organización activa recibe «no encontrado» (CP404), también con la cabecera de otra", () =>
    withTx(db, async () => {
      // el Dueño de B con la cabecera de A: no es miembro
      await asUser(db, w.ownerB, w.tenantA);
      const error = await expectSqlError(db, SET, [500]);
      expect(error.code).toBe("CP404");
      await actAsPostgres(db);
      expect(await capOf(w.tenantA)).toBeNull();
      expect(await capOf(w.tenantB)).toBeNull();
    }));

  it("fuera de rango: CP422 `invalid_max_discount`", () =>
    withTx(db, async () => {
      for (const bad of [-1, 10_000, 100_000]) {
        await asUser(db, w.owner, w.tenantA);
        const error = await expectSqlError(db, SET, [bad]);
        expect(error.code, String(bad)).toBe("CP422");
        expect(error.message).toBe("invalid_max_discount");
      }
      expect(await capOf(w.tenantA)).toBeNull();
    }));

  it("el mismo valor otra vez devuelve `changed: false` y NO audita; un cambio audita el valor anterior y el nuevo", () =>
    withTx(db, async () => {
      expect(await setAs(w.owner, 1_000)).toMatchObject({ changed: true });
      expect(await setAs(w.owner, 1_000)).toEqual({ changed: false, max_discount_bp: 1_000 });
      expect(await setAs(w.owner, null)).toMatchObject({ changed: true });
      expect(await setAs(w.owner, null)).toEqual({ changed: false, max_discount_bp: null });
      const audits = await capAudits(w.tenantA);
      expect(audits).toHaveLength(2);
      expect(audits[0]).toEqual({
        old: { max_discount_bp: null },
        new: { max_discount_bp: 1_000 },
      });
      expect(audits[1]).toEqual({
        old: { max_discount_bp: 1_000 },
        new: { max_discount_bp: null },
      });
    }));

  it("cambiar la de A no toca la de B", () =>
    withTx(db, async () => {
      await setAs(w.owner, 1_234);
      expect(await capOf(w.tenantB)).toBeNull();
      await setAs(w.ownerB, 4_321, w.tenantB);
      expect(await capOf(w.tenantA)).toBe(1_234);
      expect(await capOf(w.tenantB)).toBe(4_321);
    }));

  it("escribir `max_discount_bp` directo con el pase de la persona se rechaza, aunque sea el Dueño", () =>
    withTx(db, async () => {
      for (const user of [w.owner, w.admin, w.sales]) {
        await asUser(db, user, w.tenantA);
        const error = await expectSqlError(
          db,
          "update public.tenants set max_discount_bp = 1 where tenant_id = $1",
          [w.tenantA],
        );
        expect(error.code, user.id).toBe("42501");
      }
      await actAsPostgres(db);
      expect(await capOf(w.tenantA)).toBeNull();
    }));

  it("la base rechaza un tope fuera de rango aunque se escriba directo (restricción de la tabla)", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      for (const bad of [-1, 10_000]) {
        const error = await expectSqlError(
          db,
          "update public.tenants set max_discount_bp = $2 where tenant_id = $1",
          [w.tenantA, bad],
        );
        expect(error.code).toBe("23514");
      }
    }));

  it("todo miembro LEE el tope de su organización (también el Comercial y el Observador)", () =>
    withTx(db, async () => {
      await setCap(w.tenantA, 1_000);
      for (const user of [w.owner, w.sales, w.approver, w.viewer]) {
        await asUser(db, user, w.tenantA);
        const { rows } = await db.query(
          "select max_discount_bp from public.tenants where tenant_id = $1",
          [w.tenantA],
        );
        expect(rows[0].max_discount_bp, user.id).toBe(1_000);
      }
    }));

  it("la función no es de anon ni de PUBLIC, y la de la regla es solo interna", async () => {
    await actAsPostgres(db);
    const { rows } = await db.query<{ name: string; anon: boolean; auth: boolean }>(
      `select p.proname as name,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname in ('set_quote_max_discount', 'quote_line_rules_check', 'line_rule_issues',
                            'line_price_lock_broken', 'discount_over_cap', 'locked_price_override_lines',
                            'can_quote_catalog_item', 'quote_packages_line_rules_gate')
        order by 1`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(Object.keys(byName)).toHaveLength(8);
    for (const r of rows) expect(r.anon, r.name).toBe(false);
    expect(byName.set_quote_max_discount.auth).toBe(true);
    for (const name of Object.keys(byName).filter((n) => n !== "set_quote_max_discount")) {
      expect(byName[name].auth, name).toBe(false);
    }
  });
});

describe("el candado del catálogo", () => {
  it("Dueño y Administrador lo bloquean y desbloquean; el Comercial no puede (la regla por fila exige `catalog.manage`)", () =>
    withTx(db, async () => {
      const service = await addCatalogItem(db, w.tenantA, CATALOG);
      for (const user of [w.owner, w.admin]) {
        await asUser(db, user, w.tenantA);
        await db.query("update public.catalog_items set price_locked = true where id = $1", [
          service,
        ]);
        await actAsPostgres(db);
        const { rows } = await db.query(
          "select price_locked from public.catalog_items where id = $1",
          [service],
        );
        expect(rows[0].price_locked, user.id).toBe(true);
        await asUser(db, user, w.tenantA);
        await db.query("update public.catalog_items set price_locked = false where id = $1", [
          service,
        ]);
      }
      for (const user of [w.sales, w.approver, w.viewer]) {
        await asUser(db, user, w.tenantA);
        const { rowCount } = await db.query(
          "update public.catalog_items set price_locked = true where id = $1",
          [service],
        );
        expect(rowCount, user.id).toBe(0);
      }
      await actAsPostgres(db);
      const { rows } = await db.query(
        "select price_locked from public.catalog_items where id = $1",
        [service],
      );
      expect(rows[0].price_locked).toBe(false);
    }));

  it("el Dueño crea un servicio ya bloqueado, y el cambio de candado queda en la auditoría con el valor anterior y el nuevo", () =>
    withTx(db, async () => {
      await asUser(db, w.owner, w.tenantA);
      const id = randomUUID();
      await db.query(
        `insert into public.catalog_items (id, name, unit, unit_price_clp, price_locked)
         values ($1, 'Servicio bloqueado nuevo', 'service', 5000, true)`,
        [id],
      );
      await db.query("update public.catalog_items set price_locked = false where id = $1", [id]);
      await actAsPostgres(db);
      const { rows } = await db.query<{ action: string; details: Record<string, unknown> }>(
        `select action, details from public.audit_log where resource_id = $1 order by id`,
        [id],
      );
      expect(rows.map((r) => r.action)).toEqual(["catalog_item.created", "catalog_item.updated"]);
      expect(rows[1].details).toEqual({
        old: { price_locked: true },
        new: { price_locked: false },
      });
    }));

  it("el candado no se copia a `quote_items`", async () => {
    await actAsPostgres(db);
    const { rows } = await db.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name in ('quote_items', 'quote_packages')
          and column_name like '%price_locked%'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("el candado y el tope se leen siempre por (organización, id)", () => {
  const CHECK = "select app.quote_line_rules_check($1, $2, $3) as r";
  const oneLine = (catalogItemId: string | null, price: number, catalogPrice: number | null) =>
    JSON.stringify([
      {
        catalog_item_id: catalogItemId,
        catalog_unit_price_clp: catalogPrice,
        unit_price_clp: price,
        discount_kind: "none",
        discount_value: 0,
        gross_clp: price,
      },
    ]);

  it("un servicio bloqueado de B, nombrado desde A, no existe para A: no hay `price_locked`", () =>
    withTx(db, async () => {
      const ofB = await addCatalogItem(db, w.tenantB, CATALOG);
      await lockService(ofB);
      const own = await addCatalogItem(db, w.tenantA, CATALOG);
      await lockService(own);
      await asUser(db, w.sales, w.tenantA);
      await actAsPostgres(db); // la función es interna: la llama el servidor de la base, con el pase de la persona puesto
      const foreign = await db.query(CHECK, [w.tenantA, oneLine(ofB, 1, CATALOG), null]);
      expect(foreign.rows[0].r).toEqual({ issues: [], overrides: [] });
      // el propio, en las mismas condiciones, sí
      const mine = await db.query(CHECK, [w.tenantA, oneLine(own, 1, CATALOG), null]);
      expect(mine.rows[0].r.issues).toEqual(["price_locked@0"]);
    }));

  it("el tope y el permiso son los de la organización que se pregunta: nadie se salta la regla de otra", () =>
    withTx(db, async () => {
      await setCap(w.tenantB, 4_321);
      await setCap(w.tenantA, 500);
      const global = JSON.stringify({ kind: "percent", value: 5_000, base_clp: 10_000 });
      // el Dueño de A (con la regla de A) se salta todo; con la de B (tope 43,21 %), no
      await asUser(db, w.owner, w.tenantA);
      await actAsPostgres(db);
      expect((await db.query(CHECK, [w.tenantA, "[]", global])).rows[0].r.issues).toEqual([]);
      const asForeign = await db.query(CHECK, [w.tenantB, "[]", global]);
      expect(asForeign.rows[0].r.issues).toEqual(["global_discount_over_cap"]);
      // el Comercial de A: el tope de A (5 %) vale para A y el de B (43,21 %) para B; un 40 % pasa en B y no en A
      await asUser(db, w.sales, w.tenantA);
      await actAsPostgres(db);
      expect((await db.query(CHECK, [w.tenantA, "[]", global])).rows[0].r.issues).toEqual([
        "global_discount_over_cap",
      ]);
      const forty = JSON.stringify({ kind: "percent", value: 4_000, base_clp: 10_000 });
      expect((await db.query(CHECK, [w.tenantB, "[]", forty])).rows[0].r.issues).toEqual([]);
    }));
});

describe("`save_quote_draft` conserva sus otras reglas", () => {
  it("solo el autor edita su borrador, y un Observador o Aprobador no guarda", () =>
    withTx(db, async () => {
      const quoteId = await newQuote(w.sales);
      expect((await saveFails(w.sales2, quoteId, [{ price: CATALOG }])).code).toBe("42501");
      expect((await saveFails(w.viewer, quoteId, [{ price: CATALOG }])).code).toBe("42501");
      expect((await saveFails(w.approver, quoteId, [{ price: CATALOG }])).code).toBe("42501");
      expect(await stored(quoteId)).toEqual({ revision: 1, lines: 0 });
    }));

  it("un cálculo que no coincide sigue dando CP500 antes de mirar la regla", () =>
    withTx(db, async () => {
      await setCap(w.tenantA, 0);
      const quoteId = await newQuote(w.sales);
      const p = payload([{ price: CATALOG, discount: { kind: "percent", bp: 5_000 } }]);
      await asUser(db, w.sales, w.tenantA);
      const error = await expectSqlError(db, SAVE, [
        quoteId,
        1,
        randomUUID(),
        p.header,
        p.lines,
        JSON.stringify({ ...JSON.parse(p.totals), totalClp: 1 }),
      ]);
      expect(error.code).toBe("CP500");
    }));
});
