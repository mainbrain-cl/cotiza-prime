// H-012 · Ciclo de vida de la pertenencia (ataques A12 y X9): quien deja de ser miembro, o una
// organización archivada, dejan de ver y de tocar datos AUNQUE el pase de sesión siga vigente.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rest, rpc } from "../support/local-supabase";
import { countWhere, fixture, isRejectedOrEmpty, openDb, tenantHeader, tokenOf } from "./context";
import { removeExMember } from "./fixture";
import { allColumnsOf, ISOLATION_TABLES } from "./registry";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

type Row = Record<string, unknown>;

describe("A12 · una persona quitada de la organización, con su pase todavía vigente", () => {
  it("antes de quitarla ve los datos (control); después, nada, con el MISMO pase", async () => {
    const fx = fixture();
    const A = fx.orgs.A.tenantId;
    const token = await tokenOf("ex"); // pase real obtenido ANTES de quitarla

    const visibleBefore = await rest(token, "customers?select=id", { headers: tenantHeader(A) });
    expect((visibleBefore.json as Row[]).length).toBeGreaterThan(0);
    const tenantsBefore = await rest(token, "tenants?select=tenant_id");
    expect((tenantsBefore.json as Row[]).map((r) => r.tenant_id)).toContain(A);

    await removeExMember(fx);

    // Lectura: cero filas en toda tabla de negocio
    for (const spec of ISOLATION_TABLES.filter((t) => t.visibility === "business")) {
      const res = await rest(token, `${spec.name}?select=${allColumnsOf(spec)}`, {
        headers: { Prefer: "count=exact", ...tenantHeader(A) },
      });
      expect(res.json, spec.name).toEqual([]);
    }
    const tenantsAfter = await rest(token, "tenants?select=tenant_id");
    expect((tenantsAfter.json as Row[]).map((r) => r.tenant_id)).not.toContain(A);

    // Escritura: rechazada
    const insert = await rest(token, "customers", {
      method: "POST",
      headers: { Prefer: "return=representation", ...tenantHeader(A) },
      body: {
        id: crypto.randomUUID(),
        tenant_id: A,
        kind: "person",
        display_name: `ATAQUE-${fx.runId}-ex`,
      },
    });
    expect(isRejectedOrEmpty(insert), insert.text).toBe(true);
    const update = await rest(token, `catalog_items?id=eq.${fx.orgs.A.catalogIds[0]}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation", ...tenantHeader(A) },
      body: { name: `ATAQUE-${fx.runId}-ex` },
    });
    expect(isRejectedOrEmpty(update)).toBe(true);
    expect(await countWhere(db, "customers", `display_name like 'ATAQUE-${fx.runId}-ex'`)).toBe(0);
    expect(await countWhere(db, "catalog_items", `name like 'ATAQUE-${fx.runId}-ex'`)).toBe(0);

    // Funciones: rechazadas, y volver a agregarse no es posible
    const numbering = await rpc(
      token,
      "set_numbering",
      { p_prefix: "EXX", p_mode: "yearly" },
      tenantHeader(A),
    );
    expect(numbering.status).toBeGreaterThanOrEqual(400);
    const preview = await rpc(token, "preview_next_quote_number", {}, tenantHeader(A));
    expect(preview.json).toBeNull();
    const rejoin = await rest(token, "members", {
      method: "POST",
      headers: { Prefer: "return=representation", ...tenantHeader(A) },
      body: { tenant_id: A, user_id: fx.personas.ex.userId, role: "owner" },
    });
    expect(isRejectedOrEmpty(rejoin)).toBe(true);
    const reactivate = await rest(token, `members?user_id=eq.${fx.personas.ex.userId}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation", ...tenantHeader(A) },
      body: { status: "active", removed_at: null },
    });
    expect(isRejectedOrEmpty(reactivate)).toBe(true);
    expect(
      await countWhere(db, "members", `user_id = '${fx.personas.ex.userId}' and status = 'active'`),
    ).toBe(0);
  });
});

describe("X9 · una organización archivada", () => {
  it("su Dueña no lee ni escribe datos de negocio con la cabecera de la organización archivada", async () => {
    const fx = fixture();
    const C = fx.orgs.C.tenantId;
    const token = await tokenOf("carla");
    // control: la organización existe y tiene datos
    expect(await countWhere(db, "customers", `tenant_id = '${C}'`)).toBeGreaterThan(0);

    for (const spec of ISOLATION_TABLES.filter((t) => t.visibility === "business")) {
      const res = await rest(token, `${spec.name}?select=${allColumnsOf(spec)}`, {
        headers: { Prefer: "count=exact", ...tenantHeader(C) },
      });
      expect(res.json, spec.name).toEqual([]);
    }
    const insert = await rest(token, "catalog_items", {
      method: "POST",
      headers: { Prefer: "return=representation", ...tenantHeader(C) },
      body: {
        tenant_id: C,
        name: `ATAQUE-${fx.runId}-archivada`,
        unit: "service",
        unit_price_clp: 1,
      },
    });
    expect(isRejectedOrEmpty(insert)).toBe(true);
    const rename = await rest(token, `tenants?tenant_id=eq.${C}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation", ...tenantHeader(C) },
      body: { name: `ATAQUE-${fx.runId}-archivada` },
    });
    expect(isRejectedOrEmpty(rename)).toBe(true);
    expect(await countWhere(db, "tenants", `name like 'ATAQUE-${fx.runId}-archivada'`)).toBe(0);
    const preview = await rpc(token, "preview_next_quote_number", {}, tenantHeader(C));
    expect(preview.json).toBeNull();
  });

  it("nadie más ve la organización archivada: ni en el selector ni por identificador", async () => {
    const fx = fixture();
    for (const persona of ["ana", "beto", "mixta"] as const) {
      const res = await rest(
        await tokenOf(persona),
        `tenants?tenant_id=eq.${fx.orgs.C.tenantId}&select=tenant_id`,
      );
      expect(res.json, persona).toEqual([]);
    }
  });
});
