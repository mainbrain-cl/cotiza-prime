// H-025 / H-026 · Cotizaciones: crear, guardar el borrador y sus protecciones (migración 17).
// Cada prueba corre en una transacción que se deshace. La fixture (personas y organizaciones) se
// deja confirmada una vez; no se borra (la auditoría es de solo agregar).
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateQuote, type CalcInput, type Discount } from "../../src/lib/quotes/calc";
import {
  TENANT_HEADER,
  actAs,
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  expectSqlError,
  withTx,
  type TestUser,
} from "./helpers";

const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";

let db: Client;
let owner: TestUser;
let admin: TestUser;
let sales: TestUser;
let sales2: TestUser;
let approver: TestUser;
let viewer: TestUser;
let ownerB: TestUser;
let tenantA: string;
let tenantB: string;
let customerA: string;
let customerA2: string;
let customerAnon: string;
let customerB: string;
let catTaxable: string;
let catExempt: string;
let catInactive: string;
let catB: string;

async function addMember(tenantId: string, user: TestUser, role: string) {
  await db.query("insert into public.members (tenant_id, user_id, role) values ($1, $2, $3)", [
    tenantId,
    user.id,
    role,
  ]);
}

async function addCustomer(tenantId: string, name: string, anonymized = false): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.customers (id, tenant_id, kind, display_name, anonymized_at)
     values ($1, $2, 'company', $3, case when $4 then now() end)`,
    [id, tenantId, name, anonymized],
  );
  return id;
}

async function addCatalog(
  tenantId: string,
  name: string,
  price: number,
  tax: "taxable" | "exempt" = "taxable",
  active = true,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp, tax_treatment, is_active)
     values ($1, $2, 'service', $3, $4, $5) returning id`,
    [tenantId, name, price, tax, active],
  );
  return rows[0].id;
}

beforeAll(async () => {
  db = await connect();
  await db.query("begin");
  const users: TestUser[] = [];
  for (let n = 0; n < 7; n++) users.push(await createUser(db));
  [owner, admin, sales, sales2, approver, viewer, ownerB] = users;
  tenantA = await createTenantAs(db, owner);
  tenantB = await createTenantAs(db, ownerB);
  await addMember(tenantA, admin, "admin");
  await addMember(tenantA, sales, "sales");
  await addMember(tenantA, sales2, "sales");
  await addMember(tenantA, approver, "approver");
  await addMember(tenantA, viewer, "viewer");
  customerA = await addCustomer(tenantA, "Cliente A uno");
  customerA2 = await addCustomer(tenantA, "Cliente A dos");
  customerAnon = await addCustomer(tenantA, "Cliente anonimizado", true);
  customerB = await addCustomer(tenantB, "Cliente de B");
  catTaxable = await addCatalog(tenantA, "Flete urbano", 10000);
  catExempt = await addCatalog(tenantA, "Capacitación", 5000, "exempt");
  catInactive = await addCatalog(tenantA, "Servicio retirado", 7000, "taxable", false);
  catB = await addCatalog(tenantB, "Servicio de B", 999);
  await db.query("commit");
});
afterAll(async () => {
  await db.end();
});

const asUser = (user: TestUser, tenantId = tenantA) =>
  actAs(db, user, { [TENANT_HEADER]: tenantId });

type Item = Record<string, unknown> & { id: string };
const item = (over: Record<string, unknown> = {}): Item => ({
  id: randomUUID(),
  name: "Servicio libre",
  description: null,
  unit: "service",
  tax_treatment: "taxable",
  quantity_milli: 1000,
  unit_price_clp: 10000,
  discount_kind: "none",
  discount_value: 0,
  ...over,
});

const catalogItem = (id: string, price: number, tax = "taxable", over = {}) =>
  item({
    catalog_item_id: id,
    name: "Del catálogo",
    unit_price_clp: price,
    tax_treatment: tax,
    ...over,
  });

type Header = { customer_id: string; global_discount: { kind: string; value: number } };
const header = (customerId = customerA, kind = "none", value = 0): Header => ({
  customer_id: customerId,
  global_discount: { kind, value },
});

/** Lo que calcularía la aplicación para esos datos (TypeScript), para mandarlo como "esperado". */
function expectedTotals(items: Item[], gd: Header["global_discount"], taxRateBp = 1900) {
  const toDiscount = (kind: unknown, value: unknown): Discount =>
    kind === "percent"
      ? { kind: "percent", bp: value as number }
      : kind === "amount"
        ? { kind: "amount", clp: value as number }
        : { kind: "none" };
  const input: CalcInput = {
    lines: items.map((it) => ({
      quantityMilli: it.quantity_milli as number,
      unitPriceClp: it.unit_price_clp as number,
      taxTreatment: it.tax_treatment as "taxable" | "exempt",
      discount: toDiscount(it.discount_kind, it.discount_value),
    })),
    globalDiscount: toDiscount(gd.kind, gd.value),
    taxRateBp,
  };
  const result = calculateQuote(input);
  if (!result.ok)
    throw new Error(`cálculo inválido en la prueba: ${JSON.stringify(result.issues)}`);
  return result.totals;
}

async function createQuote(user = sales, customer = customerA, key = randomUUID()) {
  await asUser(user);
  const { rows } = await db.query<{ quote_id: string; number_display: string }>(
    "select * from public.create_quote($1, $2)",
    [customer, key],
  );
  await actAsPostgres(db);
  return { id: rows[0].quote_id, number: rows[0].number_display, key };
}

async function save(
  user: TestUser,
  quoteId: string,
  revision: number,
  items: Item[],
  hdr: Header = header(),
  opts: { saveId?: string; totals?: unknown } = {},
) {
  await asUser(user);
  try {
    const { rows } = await db.query<{
      r: { revision: number; totals: unknown; replayed?: boolean };
    }>("select public.save_quote_draft($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb) as r", [
      quoteId,
      revision,
      opts.saveId ?? randomUUID(),
      JSON.stringify(hdr),
      JSON.stringify(items),
      JSON.stringify(opts.totals ?? expectedTotals(items, hdr.global_discount)),
    ]);
    return rows[0].r;
  } finally {
    await actAsPostgres(db);
  }
}

/** Intenta guardar esperando un error; devuelve su código y mensaje. */
async function saveError(
  user: TestUser,
  quoteId: string,
  revision: number,
  items: Item[],
  hdr: Header = header(),
  opts: { saveId?: string; totals?: unknown } = {},
) {
  await asUser(user);
  const error = await expectSqlError(
    db,
    "select public.save_quote_draft($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)",
    [
      quoteId,
      revision,
      opts.saveId ?? randomUUID(),
      JSON.stringify(hdr),
      JSON.stringify(items),
      JSON.stringify(opts.totals ?? {}),
    ],
  );
  await actAsPostgres(db);
  return error;
}

const quoteRow = async (id: string) =>
  (await db.query("select * from public.quotes where id = $1", [id])).rows[0];
const lineRows = async (id: string) =>
  (await db.query("select * from public.quote_items where quote_id = $1 order by position", [id]))
    .rows;

describe("create_quote", () => {
  it("crea un borrador con el número de la organización, la historia y el IVA congelado", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      expect(q.number).toMatch(/^COT-\d{4}-0001$/);
      const row = await quoteRow(q.id);
      expect(row).toMatchObject({
        tenant_id: tenantA,
        status: "draft",
        version: 1,
        revision: 1,
        tax_rate_bp: 1900,
        currency: "CLP",
        total_clp: "0",
        customer_id: customerA,
        created_by: sales.id,
        root_quote_id: q.id,
        number_seq: "1",
      });
      const { rows: events } = await db.query(
        "select type, actor_type, actor_user_id, data from public.quote_events where quote_id = $1",
        [q.id],
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "created",
        actor_type: "user",
        actor_user_id: sales.id,
      });
      expect(events[0].data).toEqual({ number_display: q.number, version: 1 });
      // la historia no lleva datos personales: solo número y versión
      expect(JSON.stringify(events[0].data)).not.toMatch(/Cliente|@/);
    });
  });

  it("la misma clave de creación devuelve la misma cotización, sin gastar otro número", async () => {
    await withTx(db, async () => {
      const key = randomUUID();
      const first = await createQuote(sales, customerA, key);
      const again = await createQuote(sales, customerA2, key);
      expect(again.id).toBe(first.id);
      expect(again.number).toBe(first.number);
      const { rows } = await db.query(
        "select count(*)::int as n from public.quotes where creation_key = $1",
        [key],
      );
      expect(rows[0].n).toBe(1);
      const next = await createQuote();
      expect(Number((await quoteRow(next.id)).number_seq)).toBe(
        Number((await quoteRow(first.id)).number_seq) + 1,
      );
    });
  });

  it("dueño, administrador y comercial crean; aprobador y observador no", async () => {
    await withTx(db, async () => {
      for (const user of [owner, admin, sales]) {
        expect((await createQuote(user)).id).toBeTruthy();
      }
      for (const user of [approver, viewer]) {
        await asUser(user);
        const error = await expectSqlError(db, "select * from public.create_quote($1, $2)", [
          customerA,
          randomUUID(),
        ]);
        expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
        await actAsPostgres(db);
      }
    });
  });

  it("rechaza un cliente anonimizado, uno de otra organización y uno que no existe (CP404)", async () => {
    await withTx(db, async () => {
      await asUser(sales);
      for (const customer of [customerAnon, customerB, randomUUID()]) {
        const error = await expectSqlError(db, "select * from public.create_quote($1, $2)", [
          customer,
          randomUUID(),
        ]);
        expect(error.code).toBe("CP404");
      }
      await actAsPostgres(db);
      const { rows } = await db.query(
        "select count(*)::int as n from public.quotes where tenant_id = $1",
        [tenantA],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  it("sin organización activa o con una organización ajena, no crea (42501)", async () => {
    await withTx(db, async () => {
      await actAs(db, sales, {});
      expect(
        (
          await expectSqlError(db, "select * from public.create_quote($1, $2)", [
            customerA,
            randomUUID(),
          ])
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      await actAs(db, sales, { [TENANT_HEADER]: tenantB });
      expect(
        (
          await expectSqlError(db, "select * from public.create_quote($1, $2)", [
            customerB,
            randomUUID(),
          ])
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      await actAsPostgres(db);
    });
  });
});

describe("save_quote_draft · guardado", () => {
  it("guarda líneas, totales y revisión; lo guardado coincide con lo calculado", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      const lines = [
        item({
          name: "Con descuento",
          quantity_milli: 2500,
          unit_price_clp: 18000,
          discount_kind: "percent",
          discount_value: 1000,
        }),
        item({ name: "Exenta", tax_treatment: "exempt", unit_price_clp: 5001 }),
        catalogItem(catTaxable, 10000, "taxable", { discount_kind: "amount", discount_value: 500 }),
      ];
      const gd = { kind: "amount", value: 1000 };
      const result = await save(sales, q.id, 1, lines, header(customerA2, gd.kind, gd.value));
      expect(result.revision).toBe(2);
      const expected = expectedTotals(lines, gd);
      expect(result.totals).toEqual(expected);

      const row = await quoteRow(q.id);
      expect(row).toMatchObject({
        revision: 2,
        customer_id: customerA2,
        global_discount_kind: "amount",
        global_discount_value: "1000",
        subtotal_clp: String(expected.subtotalClp),
        net_taxable_clp: String(expected.netTaxableClp),
        net_exempt_clp: String(expected.netExemptClp),
        tax_clp: String(expected.taxClp),
        total_clp: String(expected.totalClp),
      });
      // Subtotal − descuento global + IVA = total
      expect(Number(row.subtotal_clp) - Number(row.global_discount_clp) + Number(row.tax_clp)).toBe(
        Number(row.total_clp),
      );

      const rows = await lineRows(q.id);
      expect(rows.map((r) => r.position)).toEqual([1, 2, 3]);
      expect(rows.map((r) => r.name)).toEqual(["Con descuento", "Exenta", "Del catálogo"]);
      expect(rows.map((r) => Number(r.line_total_clp))).toEqual(
        expected.lines.map((l) => l.totalClp),
      );
      expect(rows[2].catalog_unit_price_clp).toBe("10000");
      expect(rows[0].catalog_unit_price_clp).toBeNull();
    });
  });

  it("revisión vieja: CP409 y no cambia nada", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      await save(sales, q.id, 1, [item()]);
      const error = await saveError(sales, q.id, 1, [item({ name: "Otra pestaña" })]);
      expect(error.code).toBe("CP409");
      expect((await lineRows(q.id)).map((r) => r.name)).toEqual(["Servicio libre"]);
      expect((await quoteRow(q.id)).revision).toBe(2);
    });
  });

  it("un guardado repetido (mismo save_id) no se aplica dos veces", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      const saveId = randomUUID();
      const lines = [item()];
      const first = await save(sales, q.id, 1, lines, header(), { saveId });
      expect(first.revision).toBe(2);
      const again = await save(sales, q.id, 1, lines, header(), { saveId });
      expect(again.replayed).toBe(true);
      expect(again.revision).toBe(2);
      expect((await quoteRow(q.id)).revision).toBe(2);
    });
  });

  it("solo el autor edita: otro comercial, administrador y dueño reciben 42501", async () => {
    await withTx(db, async () => {
      const q = await createQuote(sales);
      for (const user of [sales2, admin, owner]) {
        expect((await saveError(user, q.id, 1, [item()])).code).toBe(INSUFFICIENT_PRIVILEGE);
      }
      for (const user of [approver, viewer]) {
        expect((await saveError(user, q.id, 1, [item()])).code).toBe(INSUFFICIENT_PRIVILEGE);
      }
      expect((await quoteRow(q.id)).revision).toBe(1);
    });
  });

  it("una cotización que ya no es borrador no se edita (CP423); 'cambios solicitados' sí", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      await db.query("update public.quotes set status = 'sent' where id = $1", [q.id]);
      expect((await saveError(sales, q.id, 1, [item()])).code).toBe("CP423");
      await db.query("update public.quotes set status = 'changes_requested' where id = $1", [q.id]);
      expect((await save(sales, q.id, 1, [item()])).revision).toBe(2);
    });
  });

  it("totales alterados: CP500 y no guarda nada", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      const lines = [item()];
      const forged = { ...expectedTotals(lines, { kind: "none", value: 0 }), totalClp: 1 };
      const error = await saveError(sales, q.id, 1, lines, header(), { totals: forged });
      expect(error.code).toBe("CP500");
      expect(await lineRows(q.id)).toHaveLength(0);
      expect((await quoteRow(q.id)).revision).toBe(1);
      expect((await quoteRow(q.id)).total_clp).toBe("0");
    });
  });

  it("el trato tributario de una línea del catálogo lo fija la base (CP422)", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      const forged = catalogItem(catTaxable, 10000, "exempt");
      expect(
        (
          await saveError(sales, q.id, 1, [forged], header(), {
            totals: expectedTotals([forged], { kind: "none", value: 0 }),
          })
        ).code,
      ).toBe("CP422");
      const wrongUnit = catalogItem(catTaxable, 10000, "taxable", { unit: "hour" });
      expect(
        (
          await saveError(sales, q.id, 1, [wrongUnit], header(), {
            totals: expectedTotals([wrongUnit], { kind: "none", value: 0 }),
          })
        ).code,
      ).toBe("CP422");
      expect(await lineRows(q.id)).toHaveLength(0);
    });
  });

  it("el precio de catálogo guardado sale del catálogo, no del navegador", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      // la persona ajusta el precio de la línea a 9.000; el del catálogo (10.000) se conserva aparte
      const line = catalogItem(catTaxable, 9000);
      await save(sales, q.id, 1, [line]);
      const [row] = await lineRows(q.id);
      expect(row.unit_price_clp).toBe("9000");
      expect(row.catalog_unit_price_clp).toBe("10000");
    });
  });

  it("servicio desactivado: se rechaza en una línea nueva y se conserva en la existente", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      const first = catalogItem(catTaxable, 10000);
      await save(sales, q.id, 1, [first]);
      await db.query("update public.catalog_items set is_active = false where id = $1", [
        catTaxable,
      ]);
      // la existente sigue (puede cambiar cantidad)
      const edited = { ...first, quantity_milli: 3000 };
      expect((await save(sales, q.id, 2, [edited])).revision).toBe(3);
      // una nueva con ese servicio no
      const fresh = catalogItem(catTaxable, 10000);
      expect(
        (
          await saveError(sales, q.id, 3, [edited, fresh], header(), {
            totals: expectedTotals([edited, fresh], { kind: "none", value: 0 }),
          })
        ).code,
      ).toBe("CP422");
      // y tampoco con el que nació desactivado
      const born = catalogItem(catInactive, 7000);
      expect(
        (
          await saveError(sales, q.id, 3, [born], header(), {
            totals: expectedTotals([born], { kind: "none", value: 0 }),
          })
        ).code,
      ).toBe("CP422");
    });
  });

  it("un cambio de precio en el catálogo no altera las líneas ya guardadas", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      const line = catalogItem(catTaxable, 10000);
      await save(sales, q.id, 1, [line]);
      await db.query("update public.catalog_items set unit_price_clp = 99999 where id = $1", [
        catTaxable,
      ]);
      const [row] = await lineRows(q.id);
      expect(row.unit_price_clp).toBe("10000");
      expect(row.catalog_unit_price_clp).toBe("10000");
      // guardar de nuevo con el mismo precio conserva el congelado
      await save(sales, q.id, 2, [line]);
      const [after] = await lineRows(q.id);
      expect(after.catalog_unit_price_clp).toBe("10000");
      // una línea nueva trae el precio nuevo del catálogo
      const fresh = catalogItem(catTaxable, 99999);
      await save(sales, q.id, 3, [line, fresh]);
      expect((await lineRows(q.id)).map((r) => r.catalog_unit_price_clp)).toEqual([
        "10000",
        "99999",
      ]);
    });
  });

  it("una línea existente no puede cambiar de servicio, unidad ni trato (CP422)", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      const line = catalogItem(catTaxable, 10000);
      await save(sales, q.id, 1, [line]);
      const swapped = { ...line, catalog_item_id: catExempt, tax_treatment: "exempt" };
      const totals = expectedTotals([swapped], { kind: "none", value: 0 });
      expect((await saveError(sales, q.id, 2, [swapped], header(), { totals })).code).toBe("CP422");
      const freed = { ...line, catalog_item_id: null };
      expect(
        (
          await saveError(sales, q.id, 2, [freed], header(), {
            totals: expectedTotals([freed], { kind: "none", value: 0 }),
          })
        ).code,
      ).toBe("CP422");
    });
  });

  it("servicios de otra organización no se pueden agregar (CP422)", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      const foreign = catalogItem(catB, 999);
      expect(
        (
          await saveError(sales, q.id, 1, [foreign], header(), {
            totals: expectedTotals([foreign], { kind: "none", value: 0 }),
          })
        ).code,
      ).toBe("CP422");
    });
  });

  it("reordenar y eliminar líneas se guarda; las líneas conservan su identidad", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      const a = item({ name: "A" });
      const b = item({ name: "B" });
      const c = item({ name: "C" });
      await save(sales, q.id, 1, [a, b, c]);
      await save(sales, q.id, 2, [c, a]);
      const rows = await lineRows(q.id);
      expect(rows.map((r) => [r.name, r.position, r.id])).toEqual([
        ["C", 1, c.id],
        ["A", 2, a.id],
      ]);
    });
  });

  it("descuento global mayor que el subtotal: se rechaza, no se recorta (CP422)", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      const lines = [item({ unit_price_clp: 10000 })];
      const error = await saveError(sales, q.id, 1, lines, header(customerA, "amount", 10001), {
        totals: {},
      });
      expect(error.code).toBe("CP422");
      expect(error.message).toContain("global_discount_exceeds_subtotal");
    });
  });

  it("validaciones de forma: 'none' con valor, clave desconocida, cliente ajeno, demasiadas líneas", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      const empty = { totals: expectedTotals([], { kind: "none", value: 0 }) };
      expect(
        (
          await saveError(
            sales,
            q.id,
            1,
            [item({ discount_kind: "none", discount_value: 5 })],
            header(),
            { totals: {} },
          )
        ).code,
      ).toBe("CP422");
      expect((await saveError(sales, q.id, 1, [], header(customerA, "none", 5), empty)).code).toBe(
        "CP422",
      );
      expect((await saveError(sales, q.id, 1, [], header(customerB), empty)).code).toBe("CP422");
      expect((await saveError(sales, q.id, 1, [], header(customerAnon), empty)).code).toBe("CP422");
      const tooMany = Array.from({ length: 201 }, () => item({ unit_price_clp: 1 }));
      expect((await saveError(sales, q.id, 1, tooMany, header(), { totals: {} })).code).toBe(
        "CP422",
      );
      // clave desconocida en el encabezado
      await asUser(sales);
      const error = await expectSqlError(
        db,
        "select public.save_quote_draft($1, 1, $2, $3::jsonb, '[]'::jsonb, $4::jsonb)",
        [
          q.id,
          randomUUID(),
          JSON.stringify({ ...header(), tax_rate_bp: 0 }),
          JSON.stringify(empty.totals),
        ],
      );
      expect(error.code).toBe("CP422");
      await actAsPostgres(db);
      expect((await quoteRow(q.id)).revision).toBe(1);
    });
  });

  it("el id de una línea de otra cotización choca sin revelar nada (CP422)", async () => {
    await withTx(db, async () => {
      const first = await createQuote();
      const second = await createQuote();
      const line = item();
      await save(sales, first.id, 1, [line]);
      const error = await saveError(sales, second.id, 1, [line], header(), {
        totals: expectedTotals([line], { kind: "none", value: 0 }),
      });
      expect(error.code).toBe("CP422");
      expect(await lineRows(second.id)).toHaveLength(0);
      expect(await lineRows(first.id)).toHaveLength(1);
    });
  });

  it("cotización inexistente o de otra organización: CP404", async () => {
    await withTx(db, async () => {
      const mine = await createQuote();
      expect((await saveError(sales, randomUUID(), 1, [])).code).toBe("CP404");
      // la dueña de B no ve la de A
      await asUser(ownerB, tenantB);
      const error = await expectSqlError(
        db,
        "select public.save_quote_draft($1, 1, $2, $3::jsonb, '[]'::jsonb, '{}'::jsonb)",
        [mine.id, randomUUID(), JSON.stringify(header(customerB))],
      );
      expect(error.code).toBe("CP404");
      await actAsPostgres(db);
    });
  });
});

describe("restricciones y permisos de las tablas", () => {
  it("la base rechaza una cotización incoherente aunque se escriba como postgres", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      const bad = async (set: string) =>
        (await expectSqlError(db, `update public.quotes set ${set} where id = $1`, [q.id])).code;
      expect(await bad("total_clp = 5")).toBe(CHECK_VIOLATION);
      expect(await bad("subtotal_clp = 5")).toBe(CHECK_VIOLATION);
      expect(await bad("tax_clp = 7")).toBe(CHECK_VIOLATION);
      expect(
        await bad(
          "total_clp = 2000000000000, subtotal_taxable_clp = 2000000000000, subtotal_clp = 2000000000000, net_taxable_clp = 2000000000000",
        ),
      ).toBe(CHECK_VIOLATION);
      expect(await bad("global_discount_kind = 'none', global_discount_value = 5")).toBe(
        CHECK_VIOLATION,
      );
      expect(await bad("global_discount_kind = 'percent', global_discount_value = 10001")).toBe(
        CHECK_VIOLATION,
      );
      expect(await bad("global_discount_kind = 'amount', global_discount_value = 1")).toBe(
        CHECK_VIOLATION,
      );
      expect(await bad("status = 'inventado'")).toBe(CHECK_VIOLATION);
      expect(await bad("tenant_id = gen_random_uuid()")).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("la base rechaza una línea incoherente aunque se escriba como postgres", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      await save(sales, q.id, 1, [item()]);
      const bad = async (set: string) =>
        (
          await expectSqlError(db, `update public.quote_items set ${set} where quote_id = $1`, [
            q.id,
          ])
        ).code;
      expect(await bad("line_total_clp = 1")).toBe(CHECK_VIOLATION);
      expect(await bad("discount_clp = 99999999, line_total_clp = -99989999")).toBe(
        CHECK_VIOLATION,
      );
      expect(await bad("discount_kind = 'none', discount_value = 5")).toBe(CHECK_VIOLATION);
      expect(await bad("discount_kind = 'percent', discount_value = 10001")).toBe(CHECK_VIOLATION);
      expect(await bad("quantity_milli = 0")).toBe(CHECK_VIOLATION);
      expect(await bad("catalog_unit_price_clp = 5")).toBe(CHECK_VIOLATION);
    });
  });

  it("quote_events no se modifica ni se borra, ni siquiera como postgres", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      for (const sql of [
        "update public.quote_events set type = 'otra' where quote_id = $1",
        "delete from public.quote_events where quote_id = $1",
      ]) {
        expect((await expectSqlError(db, sql, [q.id])).code).toBe(INSUFFICIENT_PRIVILEGE);
      }
      expect((await expectSqlError(db, "truncate public.quote_events")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });

  it("escritura directa por la API: rechazada en las tres tablas", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      await save(sales, q.id, 1, [item()]);
      await asUser(sales);
      const statements = [
        [
          "insert into public.quotes (tenant_id, number_seq, number_scope, number_display, root_quote_id, customer_id, creation_key, tax_rate_bp, created_by) values ($1, 1, 'continuous', 'X-1', gen_random_uuid(), $2, gen_random_uuid(), 1900, $3)",
          [tenantA, customerA, sales.id],
        ],
        ["update public.quotes set total_clp = 1 where id = $1", [q.id]],
        ["update public.quotes set status = 'paid' where id = $1", [q.id]],
        ["delete from public.quotes where id = $1", [q.id]],
        ["update public.quote_items set unit_price_clp = 1 where quote_id = $1", [q.id]],
        ["delete from public.quote_items where quote_id = $1", [q.id]],
        [
          "insert into public.quote_items (id, tenant_id, quote_id, position, name, unit, tax_treatment, quantity_milli, unit_price_clp, discount_kind, discount_value, gross_clp, discount_clp, line_total_clp) values (gen_random_uuid(), $1, $2, 9, 'x', 'unit', 'taxable', 1000, 1, 'none', 0, 1, 0, 1)",
          [tenantA, q.id],
        ],
        [
          "insert into public.quote_events (tenant_id, quote_id, type, actor_type) values ($1, $2, 'fake', 'user')",
          [tenantA, q.id],
        ],
        ["update public.quote_events set type = 'otra' where quote_id = $1", [q.id]],
        ["delete from public.quote_events where quote_id = $1", [q.id]],
      ] as const;
      for (const [sql, params] of statements) {
        const error = await expectSqlError(db, sql, [...params]);
        expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
      await actAsPostgres(db);
    });
  });

  it("el costo de la línea (unit_cost_clp) no se puede leer por la API", async () => {
    await withTx(db, async () => {
      const q = await createQuote();
      await save(sales, q.id, 1, [item()]);
      await asUser(sales);
      expect((await expectSqlError(db, "select unit_cost_clp from public.quote_items")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect((await expectSqlError(db, "select * from public.quote_items")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      const { rows } = await db.query(
        "select id, name, line_total_clp from public.quote_items where quote_id = $1",
        [q.id],
      );
      expect(rows).toHaveLength(1);
      await actAsPostgres(db);
    });
  });

  it("todos los roles ven todas las cotizaciones de su organización y nadie ve las de otra", async () => {
    await withTx(db, async () => {
      const q = await createQuote(sales);
      for (const user of [owner, admin, sales2, approver, viewer]) {
        await asUser(user);
        const { rows } = await db.query("select id from public.quotes where id = $1", [q.id]);
        expect(rows, user.email).toHaveLength(1);
      }
      await asUser(ownerB, tenantB);
      expect(
        (await db.query("select id from public.quotes where id = $1", [q.id])).rows,
      ).toHaveLength(0);
      expect(
        (await db.query("select id from public.quote_events where quote_id = $1", [q.id])).rows,
      ).toHaveLength(0);
      await asUser(ownerB, tenantA);
      expect(
        (await db.query("select id from public.quotes where id = $1", [q.id])).rows,
      ).toHaveLength(0);
      await actAsPostgres(db);
    });
  });

  it("anon no puede ejecutar ni leer nada de cotizaciones", async () => {
    const { rows } = await db.query<{ f: string; anon: boolean }>(
      `select f, has_function_privilege('anon', f::regprocedure, 'execute') as anon
         from unnest(array[
           'public.create_quote(uuid, uuid)',
           'public.save_quote_draft(uuid, integer, uuid, jsonb, jsonb, jsonb)']) f`,
    );
    expect(rows.every((r) => !r.anon)).toBe(true);
    const { rows: tables } = await db.query<{ t: string; anon: boolean }>(
      `select t, has_table_privilege('anon', t, 'select') as anon
         from unnest(array['public.quotes', 'public.quote_items', 'public.quote_events']) t`,
    );
    expect(tables.every((r) => !r.anon)).toBe(true);
  });
});
