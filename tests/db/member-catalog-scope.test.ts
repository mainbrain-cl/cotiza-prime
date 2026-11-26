// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · H-042 · servicios por comercial (PR 1: la base). Con pases reales de cada rol. Cada prueba corre en una transacción que se deshace.
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

const SET = "select public.set_member_catalog_scope($1, $2, $3::uuid[], $4) as r";
const SAVE = "select public.save_quote_draft($1, $2, $3, $4, $5, $6) as r";
const PRICE = 10_000;

async function memberId(user: TestUser, tenantId = w.tenantA): Promise<string> {
  await actAsPostgres(db);
  return (
    await db.query<{ id: string }>(
      "select id from public.members where tenant_id = $1 and user_id = $2",
      [tenantId, user.id],
    )
  ).rows[0].id;
}

type Result = { result: "changed" | "unchanged"; revision: number; mode: string; count: number };
async function setScope(
  user: TestUser,
  member: string,
  mode: string,
  ids: string[] | null,
  revision: number,
  tenantId = w.tenantA,
): Promise<Result> {
  await asUser(db, user, tenantId);
  const { rows } = await db.query<{ r: Result }>(SET, [member, mode, ids, revision]);
  await actAsPostgres(db);
  return rows[0].r;
}
async function setScopeFails(
  user: TestUser,
  member: string,
  mode: string,
  ids: string[] | null,
  revision: number,
  tenantId = w.tenantA,
) {
  await asUser(db, user, tenantId);
  const error = await expectSqlError(db, SET, [member, mode, ids, revision]);
  await actAsPostgres(db);
  return error;
}
async function scopeRow(member: string) {
  await actAsPostgres(db);
  const scope = await db.query<{ mode: string; revision: number }>(
    "select mode, revision from public.member_catalog_scopes where member_id = $1",
    [member],
  );
  const items = await db.query<{ catalog_item_id: string }>(
    "select catalog_item_id from public.member_catalog_scope_items where member_id = $1 order by 1",
    [member],
  );
  return { scope: scope.rows[0] ?? null, items: items.rows.map((r) => r.catalog_item_id) };
}
const sorted = (ids: string[]) => [...ids].sort();

async function offered(user: TestUser, search = "", ids: string[] | null = null) {
  await asUser(db, user, w.tenantA);
  const { rows } = await db.query<{ id: string; name: string; price_locked: boolean }>(
    "select * from public.quotable_catalog_items($1, $2::uuid[])",
    [search, ids],
  );
  await actAsPostgres(db);
  return rows;
}
async function hook(user: TestUser, item: string, tenantId = w.tenantA): Promise<boolean> {
  await asUser(db, user, tenantId);
  const { rows } = await db.query<{ ok: boolean }>("select app.can_quote_catalog_item($1) as ok", [
    item,
  ]);
  await actAsPostgres(db);
  return rows[0].ok;
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
function saveArgs(lines: L[]) {
  const calc = calculateQuote({
    lines: lines.map((l) => ({
      quantityMilli: 1000,
      unitPriceClp: l.price ?? PRICE,
      taxTreatment: "taxable" as const,
      discount: { kind: "none" as const },
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
          ...(l.catalogItemId ? { catalog_item_id: l.catalogItemId } : {}),
        }),
      ),
    ),
    JSON.stringify(calc.totals),
  ];
}
async function revisionOf(quoteId: string): Promise<number> {
  await actAsPostgres(db);
  return (
    await db.query<{ revision: number }>("select revision from public.quotes where id = $1", [
      quoteId,
    ])
  ).rows[0].revision;
}
async function save(user: TestUser, quoteId: string, lines: L[]) {
  const rev = await revisionOf(quoteId);
  await asUser(db, user, w.tenantA);
  await db.query(SAVE, [quoteId, rev, randomUUID(), ...saveArgs(lines)]);
  await actAsPostgres(db);
}
async function saveFails(user: TestUser, quoteId: string, lines: L[]) {
  const rev = await revisionOf(quoteId);
  await asUser(db, user, w.tenantA);
  const error = await expectSqlError(db, SAVE, [quoteId, rev, randomUUID(), ...saveArgs(lines)]);
  await actAsPostgres(db);
  return error;
}
async function auditOf(member: string) {
  await actAsPostgres(db);
  return (
    await db.query<{ details: Record<string, unknown>; actor_user_id: string; result: string }>(
      `select details, actor_user_id, result from public.audit_log
        where resource_id = $1 and action = 'member.catalog_scope_changed' order by id`,
      [member],
    )
  ).rows;
}

describe("quién puede fijar la regla", () => {
  it("el Dueño y el Administrador limitan a un Comercial; los demás roles no pueden", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      expect(await setScope(w.owner, carla, "list", [a], 0)).toMatchObject({
        result: "changed",
        revision: 1,
        mode: "list",
        count: 1,
      });
      expect(await setScope(w.admin, carla, "all", null, 1)).toMatchObject({
        result: "changed",
        revision: 2,
        mode: "all",
      });
      for (const user of [w.approver, w.sales, w.sales2, w.viewer]) {
        const error = await setScopeFails(user, carla, "list", [a], 2);
        expect(error.code, user.id).toBe("42501");
      }
      // nada cambió con los rechazos
      expect((await scopeRow(carla)).scope).toMatchObject({ mode: "all", revision: 2 });
    }));

  it("un Comercial no puede cambiar su propia regla", () =>
    withTx(db, async () => {
      const mine = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      const error = await setScopeFails(w.sales, mine, "list", [a], 0);
      expect(error.code).toBe("42501");
      expect((await scopeRow(mine)).scope).toBeNull();
    }));

  it("solo se limita a quien puede cotizar y no maneja el catálogo: al Dueño, Administrador, Aprobador y Observador, no; y nadie cambia su propia regla", () =>
    withTx(db, async () => {
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      // el Administrador actúa sobre el Dueño, el Aprobador y el Observador; el Dueño, sobre el Administrador
      for (const [actor, target] of [
        [w.admin, w.owner],
        [w.admin, w.approver],
        [w.admin, w.viewer],
        [w.owner, w.admin],
      ] as const) {
        const error = await setScopeFails(actor, await memberId(target), "list", [a], 0);
        expect(error.code, target.id).toBe("CP422");
        expect(error.message, target.id).toBe("member_not_limitable");
      }
      // cada quien sobre sí mismo: «no puedes tocarte a ti mismo», antes de mirar si se le puede limitar
      for (const user of [w.owner, w.admin]) {
        const error = await setScopeFails(user, await memberId(user), "list", [a], 0);
        expect(error.code, user.id).toBe("CP423");
        expect(error.message, user.id).toBe("cannot_target_self");
      }
    }));

  it("sin sesión de la organización o con la organización equivocada, todo se rechaza", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      // el Dueño de A con la organización B activa: no es miembro ahí
      const wrongTenant = await setScopeFails(w.owner, carla, "list", [a], 0, w.tenantB);
      expect(wrongTenant.code).toBe("CP404");
      // el Dueño de B, activo en B, apunta a un miembro de A: «no encontrado», igual que uno inexistente
      const crossTenant = await setScopeFails(w.ownerB, carla, "list", [a], 0, w.tenantB);
      expect(crossTenant.code).toBe("CP404");
      expect(crossTenant.message).toBe("member_not_found");
      const missing = await setScopeFails(w.ownerB, randomUUID(), "list", [a], 0, w.tenantB);
      expect(missing.message).toBe("member_not_found");
      expect((await scopeRow(carla)).scope).toBeNull();
    }));
});

describe("qué se acepta al fijar la regla", () => {
  it("los bordes: lista vacía, vacío dentro de la lista, 501 servicios, modo inventado, servicio de otra organización y miembro quitado", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      const other = await addCatalogItem(db, w.tenantB, PRICE);
      expect((await setScopeFails(w.owner, carla, "list", [], 0)).message).toBe("empty_list");
      expect((await setScopeFails(w.owner, carla, "list", null, 0)).message).toBe("empty_list");
      await asUser(db, w.owner, w.tenantA);
      const withNull = await expectSqlError(
        db,
        "select public.set_member_catalog_scope($1, 'list', array[$2::uuid, null]::uuid[], 0)",
        [carla, a],
      );
      await actAsPostgres(db);
      expect(withNull.message).toBe("invalid_list");
      const many = Array.from({ length: 501 }, () => randomUUID());
      expect((await setScopeFails(w.owner, carla, "list", many, 0)).message).toBe("too_many_items");
      // el tope se mira primero: una lista enorme con un vacío dentro responde «demasiados», sin recorrerla
      await asUser(db, w.owner, w.tenantA);
      const bigWithNull = await expectSqlError(
        db,
        "select public.set_member_catalog_scope($1, 'list', array_append($2::uuid[], null::uuid), 0)",
        [carla, many],
      );
      await actAsPostgres(db);
      expect(bigWithNull.message).toBe("too_many_items");
      expect((await setScopeFails(w.owner, carla, "otro", [a], 0)).message).toBe("invalid_mode");
      expect((await setScopeFails(w.owner, carla, "all", [a], 0)).message).toBe(
        "invalid_arguments",
      );
      expect((await setScopeFails(w.owner, carla, "list", [a], -1)).message).toBe(
        "invalid_arguments",
      );
      // un servicio de otra organización (o inexistente) no cabe, sin decir cuál
      expect((await setScopeFails(w.owner, carla, "list", [a, other], 0)).message).toBe(
        "catalog_item_not_found",
      );
      expect((await setScopeFails(w.owner, carla, "list", [randomUUID()], 0)).message).toBe(
        "catalog_item_not_found",
      );
      // un miembro quitado
      await db.query(
        "update public.members set status = 'removed', removed_at = now() where id = $1",
        [carla],
      );
      expect((await setScopeFails(w.owner, carla, "list", [a], 0)).message).toBe("member_removed");
      expect((await scopeRow(carla)).scope).toBeNull();
    }));

  it("exactamente 500 servicios caben; el tope de la base es 500", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      await actAsPostgres(db);
      expect(
        (await db.query<{ n: number }>("select app.member_catalog_scope_max_items() as n")).rows[0]
          .n,
      ).toBe(500);
      const ids = (
        await db.query<{ id: string }>(
          `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp)
           select $1, 'Servicio masivo ' || g, 'service', 100 from generate_series(1, 500) g returning id`,
          [w.tenantA],
        )
      ).rows.map((r) => r.id);
      expect(ids).toHaveLength(500);
      const saved = await setScope(w.owner, carla, "list", ids, 0);
      expect(saved).toMatchObject({ result: "changed", count: 500 });
      expect((await scopeRow(carla)).items).toHaveLength(500);
    }));

  it("los repetidos se deduplican y un servicio desactivado puede estar en la lista", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      const b = await addCatalogItem(db, w.tenantA, PRICE);
      await actAsPostgres(db);
      await db.query("update public.catalog_items set is_active = false where id = $1", [b]);
      const saved = await setScope(w.owner, carla, "list", [a, a, b, a], 0);
      expect(saved).toMatchObject({ result: "changed", count: 2 });
      expect((await scopeRow(carla)).items).toEqual(sorted([a, b]));
    }));

  it("repetir lo mismo no da error ni deja otro registro; «todos» sin fila tampoco crea nada", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      const b = await addCatalogItem(db, w.tenantA, PRICE);
      // sin fila, «todos» ya es lo que hay
      expect(await setScope(w.owner, carla, "all", null, 0)).toMatchObject({
        result: "unchanged",
        revision: 0,
      });
      expect((await scopeRow(carla)).scope).toBeNull();
      expect(await auditOf(carla)).toHaveLength(0);
      // la lista, dos veces (en otro orden y con un repetido): solo el primero cambia y audita
      expect(await setScope(w.owner, carla, "list", [a, b], 0)).toMatchObject({
        result: "changed",
      });
      expect(await setScope(w.owner, carla, "list", [b, a, b], 1)).toMatchObject({
        result: "unchanged",
        revision: 1,
        count: 2,
      });
      // incluso con una versión vieja: ya está guardado lo que se pidió (el doble clic de otra pantalla)
      expect(await setScope(w.admin, carla, "list", [a, b], 0)).toMatchObject({
        result: "unchanged",
      });
      expect(await auditOf(carla)).toHaveLength(1);
      expect((await scopeRow(carla)).scope).toMatchObject({ revision: 1 });
    }));

  it("dos Administradores que se pisan: el segundo, con la versión vieja y otra lista, recibe CP409 y no cambia nada", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const [a, b, c] = [
        await addCatalogItem(db, w.tenantA, PRICE),
        await addCatalogItem(db, w.tenantA, PRICE),
        await addCatalogItem(db, w.tenantA, PRICE),
      ];
      await setScope(w.owner, carla, "list", [a], 0);
      const error = await setScopeFails(w.admin, carla, "list", [b, c], 0);
      expect(error.code).toBe("CP409");
      expect(error.message).toBe("revision_changed");
      expect((await scopeRow(carla)).items).toEqual([a]);
      // con la versión al día sí
      expect(await setScope(w.admin, carla, "list", [b, c], 1)).toMatchObject({
        result: "changed",
        revision: 2,
      });
      expect((await scopeRow(carla)).items).toEqual(sorted([b, c]));
    }));

  it("pasar de lista a «todos» borra la lista y sube la versión", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      await setScope(w.owner, carla, "list", [a], 0);
      await setScope(w.owner, carla, "all", null, 1);
      const row = await scopeRow(carla);
      expect(row.scope).toMatchObject({ mode: "all", revision: 2 });
      expect(row.items).toEqual([]);
    }));
});

describe("el historial", () => {
  it("queda `member.catalog_scope_changed` sobre el miembro, con modos, cantidades e ids; nunca nombres", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const secret = `SECRETO-${randomUUID().slice(0, 6)}`;
      const a = await addCatalogItem(db, w.tenantA, PRICE, secret);
      const b = await addCatalogItem(db, w.tenantA, PRICE);
      await setScope(w.owner, carla, "list", [a, b], 0);
      await setScope(w.owner, carla, "list", [b], 1);
      const entries = await auditOf(carla);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ actor_user_id: w.owner.id, result: "success" });
      expect(entries[0].details).toMatchObject({
        old_mode: "all",
        new_mode: "list",
        old_count: 0,
        new_count: 2,
        truncated: false,
      });
      expect(entries[0].details.added).toEqual(sorted([a, b]));
      expect(entries[1].details).toMatchObject({
        old_mode: "list",
        new_mode: "list",
        old_count: 2,
        new_count: 1,
        removed: [a],
        added: [],
      });
      expect(JSON.stringify(entries)).not.toContain(secret);
    }));

  it("con más de 50 ids, el detalle se corta a 50 y dice que se truncó (cabe en los 8 KB)", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      await actAsPostgres(db);
      const ids = (
        await db.query<{ id: string }>(
          `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp)
           select $1, 'Servicio auditoría ' || g, 'service', 100 from generate_series(1, 80) g returning id`,
          [w.tenantA],
        )
      ).rows.map((r) => r.id);
      await setScope(w.owner, carla, "list", ids, 0);
      const [entry] = await auditOf(carla);
      expect(entry.details.added).toHaveLength(50);
      expect(entry.details).toMatchObject({ new_count: 80, truncated: true });
    }));
});

describe("la escritura directa y la lectura de las tablas", () => {
  it("nadie escribe directo en las dos tablas, ni el Dueño", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      await setScope(w.owner, carla, "list", [a], 0);
      for (const user of [w.owner, w.admin, w.sales]) {
        await asUser(db, user, w.tenantA);
        for (const sql of [
          `insert into public.member_catalog_scopes (tenant_id, member_id, mode) values ('${w.tenantA}', '${carla}', 'all')`,
          `update public.member_catalog_scopes set mode = 'all' where member_id = '${carla}'`,
          `delete from public.member_catalog_scopes where member_id = '${carla}'`,
          `insert into public.member_catalog_scope_items (tenant_id, member_id, catalog_item_id) values ('${w.tenantA}', '${carla}', '${a}')`,
          `update public.member_catalog_scope_items set catalog_item_id = '${a}' where member_id = '${carla}'`,
          `delete from public.member_catalog_scope_items where member_id = '${carla}'`,
        ]) {
          const error = await expectSqlError(db, sql);
          expect(error.code, `${user.id}: ${sql}`).toBe("42501");
        }
        await actAsPostgres(db);
      }
      expect((await scopeRow(carla)).items).toEqual([a]);
    }));

  it("el Dueño y el Administrador leen las filas de su organización; el Comercial, el Aprobador y el Observador no leen ninguna; otra organización, tampoco", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      await setScope(w.owner, carla, "list", [a], 0);
      for (const [user, expected] of [
        [w.owner, 1],
        [w.admin, 1],
        [w.sales, 0],
        [w.sales2, 0],
        [w.approver, 0],
        [w.viewer, 0],
      ] as const) {
        await asUser(db, user, w.tenantA);
        const scopes = await db.query("select * from public.member_catalog_scopes");
        const items = await db.query("select * from public.member_catalog_scope_items");
        expect(scopes.rows, user.id).toHaveLength(expected);
        expect(items.rows, user.id).toHaveLength(expected);
        await actAsPostgres(db);
      }
      await asUser(db, w.ownerB, w.tenantB);
      expect((await db.query("select * from public.member_catalog_scopes")).rows).toHaveLength(0);
      expect((await db.query("select * from public.member_catalog_scope_items")).rows).toHaveLength(
        0,
      );
      await actAsPostgres(db);
    }));
});

describe("qué ofrece el cotizador (`quotable_catalog_items`)", () => {
  it("sin límite se ven todos los activos (también el Dueño y el Administrador); con lista, solo los elegidos", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE, "Flete local");
      const b = await addCatalogItem(db, w.tenantA, PRICE, "Mudanza");
      const c = await addCatalogItem(db, w.tenantA, PRICE, "Grúa");
      const all = sorted([a, b, c]);
      for (const user of [w.sales, w.owner, w.admin]) {
        expect(sorted((await offered(user)).map((r) => r.id)), user.id).toEqual(all);
      }
      await setScope(w.owner, carla, "list", [a, c], 0);
      // por nombre: «Flete local» y después «Grúa»
      expect((await offered(w.sales)).map((r) => r.id)).toEqual([a, c]);
    }));

  it("el orden es por nombre, y con lista solo salen los elegidos; el Dueño, el Administrador y otro Comercial sin regla siguen viendo todo", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE, "Zeta");
      const b = await addCatalogItem(db, w.tenantA, PRICE, "Alfa");
      const c = await addCatalogItem(db, w.tenantA, PRICE, "Beta");
      await setScope(w.owner, carla, "list", [a, b], 0);
      expect((await offered(w.sales)).map((r) => r.name)).toEqual(["Alfa", "Zeta"]);
      expect((await offered(w.sales2)).map((r) => r.id)).toEqual([b, c, a]);
      expect((await offered(w.owner)).map((r) => r.id)).toEqual([b, c, a]);
      expect((await offered(w.admin)).map((r) => r.id)).toEqual([b, c, a]);
    }));

  it("un servicio desactivado no se ofrece aunque esté en la lista; reactivado, vuelve", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE, "Uno");
      const b = await addCatalogItem(db, w.tenantA, PRICE, "Dos");
      await setScope(w.owner, carla, "list", [a, b], 0);
      await actAsPostgres(db);
      await db.query("update public.catalog_items set is_active = false where id = $1", [b]);
      expect((await offered(w.sales)).map((r) => r.id)).toEqual([a]);
      await db.query("update public.catalog_items set is_active = true where id = $1", [b]);
      expect((await offered(w.sales)).map((r) => r.id)).toEqual([b, a]);
    }));

  it("un servicio nuevo no lo ve quien tiene lista (D3) y sí quien tiene «todos»", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE, "Viejo");
      await setScope(w.owner, carla, "list", [a], 0);
      const fresh = await addCatalogItem(db, w.tenantA, PRICE, "Nuevo");
      expect((await offered(w.sales)).map((r) => r.id)).toEqual([a]);
      expect((await offered(w.sales2)).map((r) => r.id)).toContain(fresh);
      await setScope(w.owner, carla, "all", null, 1);
      expect((await offered(w.sales)).map((r) => r.id)).toContain(fresh);
    }));

  it("la búsqueda por nombre parcial escapa `%` y `_`, y con `p_ids` solo salen esos servicios", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE, "Descuento 50% flete");
      const b = await addCatalogItem(db, w.tenantA, PRICE, "Descuento 500 flete");
      const c = await addCatalogItem(db, w.tenantA, PRICE, "Servicio_especial");
      const d = await addCatalogItem(db, w.tenantA, PRICE, "ServicioXespecial");
      expect((await offered(w.owner, "50%")).map((r) => r.id)).toEqual([a]);
      expect((await offered(w.owner, "_especial")).map((r) => r.id)).toEqual([c]);
      expect(sorted((await offered(w.owner, "  DESCUENTO  ")).map((r) => r.id))).toEqual(
        sorted([a, b]),
      );
      expect(sorted((await offered(w.owner, "", [b, d])).map((r) => r.id))).toEqual(sorted([b, d]));
      // con lista, p_ids no abre lo que no está permitido
      await setScope(w.owner, carla, "list", [b], 0);
      expect((await offered(w.sales, "", [a, b, c, d])).map((r) => r.id)).toEqual([b]);
      expect((await offered(w.sales, "Servicio")).map((r) => r.id)).toEqual([]);
    }));

  it("devuelve `price_locked` y no más de 20 con búsqueda ni de 200 con ids", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const locked = await addCatalogItem(db, w.tenantA, PRICE, "AAA bloqueado");
      await db.query("update public.catalog_items set price_locked = true where id = $1", [locked]);
      await db.query(
        `insert into public.catalog_items (tenant_id, name, unit, unit_price_clp)
         select $1, 'ZZ relleno ' || g, 'service', 100 from generate_series(1, 30) g`,
        [w.tenantA],
      );
      const rows = await offered(w.sales);
      expect(rows).toHaveLength(20);
      expect(rows[0]).toMatchObject({ id: locked, price_locked: true });
      await asUser(db, w.sales, w.tenantA);
      const tooMany = await expectSqlError(
        db,
        "select * from public.quotable_catalog_items('', $1::uuid[])",
        [Array.from({ length: 201 }, () => randomUUID())],
      );
      await actAsPostgres(db);
      expect(tooMany.code).toBe("CP422");
    }));

  it("no ofrece nada de otra organización: ni por búsqueda ni por id", () =>
    withTx(db, async () => {
      const mine = await addCatalogItem(db, w.tenantA, PRICE, "Compartido");
      const theirs = await addCatalogItem(db, w.tenantB, PRICE, "Compartido");
      expect((await offered(w.owner, "Compartido", [mine, theirs])).map((r) => r.id)).toEqual([
        mine,
      ]);
      await asUser(db, w.ownerB, w.tenantB);
      const { rows } = await db.query<{ id: string }>(
        "select id from public.quotable_catalog_items('Compartido', $1::uuid[])",
        [[mine, theirs]],
      );
      await actAsPostgres(db);
      expect(rows.map((r) => r.id)).toEqual([theirs]);
      // el Dueño de A con la organización B activa: no es miembro, no ve nada
      await asUser(db, w.owner, w.tenantB);
      expect(
        (await db.query("select id from public.quotable_catalog_items('', null)")).rows,
      ).toHaveLength(0);
      await actAsPostgres(db);
    }));
});

describe("`my_catalog_scope`", () => {
  it("dice si hay límite y cuántos servicios activos puede cotizar (uno desactivado no cuenta)", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      const b = await addCatalogItem(db, w.tenantA, PRICE);
      const mine = async (user: TestUser) => {
        await asUser(db, user, w.tenantA);
        const { rows } = await db.query<{ r: { limited: boolean; allowed_count: number | null } }>(
          "select public.my_catalog_scope() as r",
        );
        await actAsPostgres(db);
        return rows[0].r;
      };
      expect(await mine(w.sales)).toEqual({ limited: false, allowed_count: null });
      await setScope(w.owner, carla, "list", [a, b], 0);
      expect(await mine(w.sales)).toEqual({ limited: true, allowed_count: 2 });
      await actAsPostgres(db);
      await db.query("update public.catalog_items set is_active = false where id = $1", [b]);
      expect(await mine(w.sales)).toEqual({ limited: true, allowed_count: 1 });
      await db.query("update public.catalog_items set is_active = false where id = $1", [a]);
      expect(await mine(w.sales)).toEqual({ limited: true, allowed_count: 0 });
      // el Dueño y otro Comercial sin regla no tienen límite
      expect(await mine(w.owner)).toEqual({ limited: false, allowed_count: null });
      expect(await mine(w.sales2)).toEqual({ limited: false, allowed_count: null });
    }));

  it("sin organización activa o sin ser miembro, responde «no encontrado»", () =>
    withTx(db, async () => {
      await asUser(db, w.owner, w.tenantB);
      const error = await expectSqlError(db, "select public.my_catalog_scope()");
      await actAsPostgres(db);
      expect(error.code).toBe("CP404");
    }));
});

describe("el gancho de `save_quote_draft` (`app.can_quote_catalog_item`)", () => {
  it("es seguro: `security definer`, `search_path` vacío, estable, sin permiso para `anon`, con permiso para `authenticated`", async () => {
    await actAsPostgres(db);
    const { rows } = await db.query<{
      secdef: boolean;
      cfg: string[] | null;
      volatility: string;
      anon: boolean;
      auth: boolean;
      args: string;
    }>(
      `select p.prosecdef as secdef, p.proconfig as cfg, p.provolatile as volatility,
              pg_get_function_arguments(p.oid) as args,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p where p.oid = 'app.can_quote_catalog_item(uuid)'::regprocedure`,
    );
    expect(rows[0]).toMatchObject({
      secdef: true,
      volatility: "s",
      anon: false,
      auth: true,
      args: "p_catalog_item_id uuid",
    });
    expect(rows[0].cfg).toContain('search_path=""');
  });

  it("sin límite responde «sí» para un servicio de la organización, y «no» para uno de otra, inexistente o nulo", () =>
    withTx(db, async () => {
      const mine = await addCatalogItem(db, w.tenantA, PRICE);
      const theirs = await addCatalogItem(db, w.tenantB, PRICE);
      for (const user of [w.sales, w.owner, w.admin]) {
        expect(await hook(user, mine), user.id).toBe(true);
        expect(await hook(user, theirs), user.id).toBe(false);
        expect(await hook(user, randomUUID()), user.id).toBe(false);
      }
      await asUser(db, w.sales, w.tenantA);
      expect(
        (await db.query<{ ok: boolean }>("select app.can_quote_catalog_item(null) as ok")).rows[0]
          .ok,
      ).toBe(false);
      await actAsPostgres(db);
    }));

  it("con lista, solo los elegidos; el Dueño y el Administrador nunca quedan limitados", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      const b = await addCatalogItem(db, w.tenantA, PRICE);
      await setScope(w.owner, carla, "list", [a], 0);
      expect(await hook(w.sales, a)).toBe(true);
      expect(await hook(w.sales, b)).toBe(false);
      expect(await hook(w.sales2, b)).toBe(true);
      expect(await hook(w.owner, b)).toBe(true);
      expect(await hook(w.admin, b)).toBe(true);
    }));

  it("ante la duda, «no»: sin ser miembro de la organización activa o un miembro quitado", () =>
    withTx(db, async () => {
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      // el Dueño de A con la organización B activa
      expect(await hook(w.owner, a, w.tenantB)).toBe(false);
      // un Comercial quitado
      const carla = await memberId(w.sales);
      await actAsPostgres(db);
      await db.query(
        "update public.members set status = 'removed', removed_at = now() where id = $1",
        [carla],
      );
      expect(await hook(w.sales, a)).toBe(false);
    }));

  it("al ascender a Administrador no queda limitado (la fila se conserva); al volver a Comercial, la lista vuelve a aplicar (D4)", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      const b = await addCatalogItem(db, w.tenantA, PRICE);
      await setScope(w.owner, carla, "list", [a], 0);
      await actAsPostgres(db);
      await db.query("update public.members set role = 'admin' where id = $1", [carla]);
      expect(await hook(w.sales, b)).toBe(true);
      expect((await offered(w.sales)).map((r) => r.id).sort()).toEqual(sorted([a, b]));
      expect((await scopeRow(carla)).scope).toMatchObject({ mode: "list" });
      await db.query("update public.members set role = 'sales' where id = $1", [carla]);
      expect(await hook(w.sales, b)).toBe(false);
      expect(await hook(w.sales, a)).toBe(true);
    }));
});

describe("`save_quote_draft` con la regla (la base la hace cumplir, no solo la pantalla)", () => {
  it("un Comercial limitado que llama directo con un servicio fuera de su lista recibe CP422 y no se guarda nada; con uno permitido, guarda", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const allowed = await addCatalogItem(db, w.tenantA, PRICE);
      const denied = await addCatalogItem(db, w.tenantA, PRICE);
      await setScope(w.owner, carla, "list", [allowed], 0);
      const quote = await newQuote(w.sales);
      const error = await saveFails(w.sales, quote, [{ id: randomUUID(), catalogItemId: denied }]);
      expect(error.code).toBe("CP422");
      expect(error.message).toBe("line_rules_invalid: catalog_item_not_allowed@0");
      expect(await revisionOf(quote)).toBe(1);
      await save(w.sales, quote, [{ id: randomUUID(), catalogItemId: allowed }]);
      expect(await revisionOf(quote)).toBe(2);
    }));

  it("una línea EXISTENTE de un servicio que salió de la lista se sigue guardando; quitarla y volver a agregarla (con id nuevo o viejo) se rechaza", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      const b = await addCatalogItem(db, w.tenantA, PRICE);
      await setScope(w.owner, carla, "list", [a, b], 0);
      const quote = await newQuote(w.sales);
      const kept = randomUUID();
      await save(w.sales, quote, [{ id: kept, catalogItemId: a }]);
      // la lista cambia: `a` sale
      await setScope(w.owner, carla, "list", [b], 1);
      // el borrador viejo se guarda tal cual (criterio 3) y también con una línea nueva permitida
      await save(w.sales, quote, [{ id: kept, catalogItemId: a }]);
      await save(w.sales, quote, [
        { id: kept, catalogItemId: a },
        { id: randomUUID(), catalogItemId: b },
      ]);
      // quitada y vuelta a agregar: es nueva y se revisa
      await save(w.sales, quote, [{ id: randomUUID(), catalogItemId: b }]);
      const withNewId = await saveFails(w.sales, quote, [{ id: randomUUID(), catalogItemId: a }]);
      expect(withNewId.message).toBe("line_rules_invalid: catalog_item_not_allowed@0");
      const withOldId = await saveFails(w.sales, quote, [{ id: kept, catalogItemId: a }]);
      expect(withOldId.message).toBe("line_rules_invalid: catalog_item_not_allowed@0");
    }));

  it("una línea libre escrita a mano no se limita (D2): ni siquiera con el nombre de un servicio prohibido", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      await addCatalogItem(db, w.tenantA, PRICE, "Mudanza");
      await setScope(w.owner, carla, "list", [a], 0);
      const quote = await newQuote(w.sales);
      await save(w.sales, quote, [{ id: randomUUID(), price: 1 }]);
      expect(await revisionOf(quote)).toBe(2);
    }));

  it("el Dueño y un Comercial sin regla agregan cualquier servicio", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      const b = await addCatalogItem(db, w.tenantA, PRICE);
      await setScope(w.owner, carla, "list", [a], 0);
      for (const user of [w.owner, w.sales2]) {
        const quote = await newQuote(user);
        await save(user, quote, [{ id: randomUUID(), catalogItemId: b }]);
        expect(await revisionOf(quote)).toBe(2);
      }
    }));
});

describe("no se toca nada de lo ya hecho", () => {
  it("cambiar una regla no cambia ninguna cotización, línea ni paquete (misma huella antes y después)", () =>
    withTx(db, async () => {
      const carla = await memberId(w.sales);
      const a = await addCatalogItem(db, w.tenantA, PRICE);
      const b = await addCatalogItem(db, w.tenantA, PRICE);
      const quote = await newQuote(w.sales);
      await save(w.sales, quote, [{ id: randomUUID(), catalogItemId: a }]);
      const fingerprint = async () => {
        await actAsPostgres(db);
        const out: string[] = [];
        for (const table of ["quotes", "quote_items", "quote_packages", "quote_events"]) {
          const { rows } = await db.query<{ h: string }>(
            `select coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h
               from public.${table} t where t.tenant_id = $1`,
            [w.tenantA],
          );
          out.push(`${table}:${rows[0].h}`);
        }
        return out;
      };
      const before = await fingerprint();
      await setScope(w.owner, carla, "list", [b], 0);
      await setScope(w.owner, carla, "list", [a], 1);
      await setScope(w.owner, carla, "all", null, 2);
      expect(await fingerprint()).toEqual(before);
    }));
});
