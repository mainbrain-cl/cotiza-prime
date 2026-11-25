// H-042 · Servicios por comercial frente a otra organización (se suma a las tablas y funciones del registro). Con pases reales y `fetch`
// directo; la verificación posterior es con `pg`: las filas de B quedan idénticas.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpc } from "../support/local-supabase";
import { countWhere, fingerprint, fixture, openDb, tenantHeader, tokenOf } from "./context";
import { ISOLATION_TABLES } from "./registry";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const spec = (name: string) => ISOLATION_TABLES.find((t) => t.name === name)!;
const scopeFingerprints = () =>
  Promise.all(
    ["member_catalog_scopes", "member_catalog_scope_items"].map((name) =>
      fingerprint(db, spec(name)),
    ),
  );

/** La regla de Sofía en A tal como la monta la fixture (modo, versión y servicios): los ataques no la tocan. La huella de arriba solo mira filas de B. */
async function sofiaRule() {
  const fx = fixture();
  const sofia = await memberIdOf(fx.orgs.A.tenantId, fx.personas.sofia.userId);
  const scope = await db.query(
    "select mode, revision from public.member_catalog_scopes where tenant_id = $1 and member_id = $2",
    [fx.orgs.A.tenantId, sofia],
  );
  const items = await db.query(
    "select catalog_item_id from public.member_catalog_scope_items where tenant_id = $1 and member_id = $2 order by 1",
    [fx.orgs.A.tenantId, sofia],
  );
  return { scope: scope.rows, items: items.rows.map((r) => r.catalog_item_id) };
}

async function memberIdOf(tenantId: string, userId: string): Promise<string> {
  return (
    await db.query<{ id: string }>(
      "select id from public.members where tenant_id = $1 and user_id = $2",
      [tenantId, userId],
    )
  ).rows[0].id;
}

const setScope = (
  token: string | null,
  header: string | undefined,
  member: string,
  mode: string,
  ids: string[] | null,
  revision: number,
) =>
  rpc(
    token,
    "set_member_catalog_scope",
    { p_member_id: member, p_mode: mode, p_catalog_item_ids: ids, p_expected_revision: revision },
    tenantHeader(header),
  );

describe("servicios por comercial · escritura por la función", () => {
  it("Ana, con A, con B o sin organización, no puede limitar al miembro de B (B idéntica y sin filtrar nada de B)", async () => {
    const fx = fixture();
    const before = await scopeFingerprints();
    const token = await tokenOf("ana");
    for (const header of [fx.orgs.A.tenantId, fx.orgs.B.tenantId, undefined]) {
      const res = await setScope(
        token,
        header,
        fx.orgs.B.ownerMemberId,
        "list",
        [fx.orgs.A.catalogIds[0]],
        1,
      );
      expect(res.status, `${header ?? "sin cabecera"}: ${res.text}`).toBeGreaterThanOrEqual(400);
      expect(res.text).not.toContain(fx.orgs.B.canary);
      expect(res.text).not.toContain(fx.orgs.B.tenantId);
    }
    expect(await scopeFingerprints()).toEqual(before);
  });

  it("con A activa, un miembro de B da «no encontrado», igual que uno inexistente (no se revela cuál existe)", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const ofB = await setScope(
      token,
      fx.orgs.A.tenantId,
      fx.orgs.B.ownerMemberId,
      "list",
      [fx.orgs.A.catalogIds[0]],
      1,
    );
    const missing = await setScope(
      token,
      fx.orgs.A.tenantId,
      "00000000-0000-4000-8000-000000000042",
      "list",
      [fx.orgs.A.catalogIds[0]],
      1,
    );
    expect(ofB.status).toBeGreaterThanOrEqual(400);
    expect(ofB.text).toContain("member_not_found");
    expect(missing.text).toContain("member_not_found");
    expect(ofB.status).toBe(missing.status);
  });

  it("Mixta, administradora de A y de B, activa en A, no puede tocar un miembro de B", async () => {
    const fx = fixture();
    const before = await scopeFingerprints();
    const res = await setScope(
      await tokenOf("mixta"),
      fx.orgs.A.tenantId,
      fx.orgs.B.ownerMemberId,
      "all",
      null,
      1,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).toContain("member_not_found");
    expect(await scopeFingerprints()).toEqual(before);
  });

  it("Ex, ya quitada de A, no puede cambiar nada", async () => {
    const ruleBefore = await sofiaRule();
    const fx = fixture();
    const before = await scopeFingerprints();
    const sofia = await memberIdOf(fx.orgs.A.tenantId, fx.personas.sofia.userId);
    const res = await setScope(await tokenOf("ex"), fx.orgs.A.tenantId, sofia, "all", null, 1);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await sofiaRule()).toEqual(ruleBefore);
    expect(await scopeFingerprints()).toEqual(before);
  });

  it("Ana no puede agregar un servicio de B a la lista de un Comercial de A: «el servicio no existe», sin decir de quién es", async () => {
    const ruleBefore = await sofiaRule();
    const fx = fixture();
    const before = await scopeFingerprints();
    const sofia = await memberIdOf(fx.orgs.A.tenantId, fx.personas.sofia.userId);
    const res = await setScope(
      await tokenOf("ana"),
      fx.orgs.A.tenantId,
      sofia,
      "list",
      [fx.orgs.A.catalogIds[0], fx.orgs.B.catalogIds[0]],
      1,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).toContain("catalog_item_not_found");
    expect(res.text).not.toContain(fx.orgs.B.catalogIds[0]);
    expect(await sofiaRule()).toEqual(ruleBefore);
    expect(await scopeFingerprints()).toEqual(before);
    // y la lista de Sofía sigue siendo la de la fixture: un solo servicio de A
    expect(
      await countWhere(
        db,
        "member_catalog_scope_items",
        `tenant_id = '${fx.orgs.A.tenantId}' and member_id = '${sofia}'`,
      ),
    ).toBe(1);
  });

  it("un Comercial de A no puede cambiar su propia regla", async () => {
    const ruleBefore = await sofiaRule();
    const fx = fixture();
    const before = await scopeFingerprints();
    const sofia = await memberIdOf(fx.orgs.A.tenantId, fx.personas.sofia.userId);
    const res = await setScope(await tokenOf("sofia"), fx.orgs.A.tenantId, sofia, "all", null, 1);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await sofiaRule()).toEqual(ruleBefore);
    expect(await scopeFingerprints()).toEqual(before);
  });
});

describe("servicios por comercial · lo que ofrece el cotizador", () => {
  it("`quotable_catalog_items` con los ids del catálogo de B no entrega nada de B (ni con A, ni con B, ni sin cabecera)", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const header of [fx.orgs.A.tenantId, fx.orgs.B.tenantId, undefined]) {
      const res = await rpc(
        token,
        "quotable_catalog_items",
        { p_search: "", p_ids: fx.orgs.B.catalogIds },
        tenantHeader(header),
      );
      expect(res.text, `${header ?? "sin cabecera"}`).not.toContain(fx.orgs.B.canary);
      for (const id of fx.orgs.B.catalogIds) expect(res.text).not.toContain(id);
      if (res.status === 200) expect(res.json).toEqual([]);
    }
  });

  it("con A activa, Ana ve solo servicios de A; Sofía (con lista) ve solo el elegido", async () => {
    const fx = fixture();
    const asAna = await rpc(
      await tokenOf("ana"),
      "quotable_catalog_items",
      { p_search: "", p_ids: null },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(asAna.status, asAna.text).toBe(200);
    const aRows = asAna.json as { id: string }[];
    expect(aRows.length).toBeGreaterThan(0);
    // todos son de A (la fixture crea además otros servicios de A, p. ej. los del formulario público)
    const owners = await db.query<{ tenant_id: string }>(
      "select tenant_id from public.catalog_items where id = any($1::uuid[])",
      [aRows.map((row) => row.id)],
    );
    expect(owners.rows).toHaveLength(aRows.length);
    for (const row of owners.rows) expect(row.tenant_id).toBe(fx.orgs.A.tenantId);
    expect(asAna.text).not.toContain(fx.orgs.B.canary);
    const asSofia = await rpc(
      await tokenOf("sofia"),
      "quotable_catalog_items",
      { p_search: "", p_ids: null },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(asSofia.status, asSofia.text).toBe(200);
    expect((asSofia.json as { id: string }[]).map((r) => r.id)).toEqual([fx.orgs.A.catalogIds[0]]);
    expect(asSofia.text).not.toContain(fx.orgs.B.canary);
  });

  it("`my_catalog_scope`: Sofía tiene límite con un servicio; Ana no; con la organización de otro, «no encontrado»", async () => {
    const fx = fixture();
    const sofia = await rpc(
      await tokenOf("sofia"),
      "my_catalog_scope",
      {},
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(sofia.status, sofia.text).toBe(200);
    expect(sofia.json).toEqual({ limited: true, allowed_count: 1 });
    const ana = await rpc(
      await tokenOf("ana"),
      "my_catalog_scope",
      {},
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(ana.json).toEqual({ limited: false, allowed_count: null });
    const wrong = await rpc(
      await tokenOf("ana"),
      "my_catalog_scope",
      {},
      tenantHeader(fx.orgs.B.tenantId),
    );
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.text).not.toContain(fx.orgs.B.canary);
  });
});
