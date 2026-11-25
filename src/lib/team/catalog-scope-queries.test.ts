import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";

// Lo que lee la sección «Servicios que puede cotizar» de la ficha (H-042): la regla de UN miembro, su lista y el catálogo, todo con el pase
// de la persona y filtrado por la organización activa.
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn(async () => {}) }));

const TENANT = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0001";
const MEMBER = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0011";
type Answer = { data: unknown; error: { code: string } | null };
let answers: Record<string, Answer> = {};
const filters: Array<[string, string, unknown]> = [];
const tables: string[] = [];
function builder(table: string) {
  tables.push(table);
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = (column: string, value: unknown) => {
    filters.push([table, column, value]);
    return b;
  };
  b.order = () => b;
  b.limit = () => b;
  b.maybeSingle = async () => answers[table];
  b.then = (resolve: (value: Answer) => unknown) => Promise.resolve(answers[table]).then(resolve);
  return b;
}
const active = {
  tenantId: TENANT,
  role: "owner",
  supabase: { from: (table: string) => builder(table) },
} as unknown as ActiveTenant;

const { loadCatalogScope } = await import("./catalog-scope-queries");
const { NO_CATALOG_SCOPE, SCOPE_CATALOG_LIMIT } = await import("./catalog-scope-model");

const catalogRow = (id: string, name: string, isActive = true) => ({
  id,
  name,
  unit: "service",
  unit_price_clp: 10_000,
  is_active: isActive,
});

beforeEach(() => {
  answers = {
    member_catalog_scopes: { data: null, error: null },
    member_catalog_scope_items: { data: [], error: null },
    catalog_items: {
      data: [catalogRow("a", "Flete"), catalogRow("b", "Viejo", false)],
      error: null,
    },
    profiles: { data: { full_name: "Ana Dueña" }, error: null },
  };
  filters.length = 0;
  tables.length = 0;
});

describe("loadCatalogScope", () => {
  it("sin regla guardada: «todos», versión 0, y el catálogo con el formato de la pantalla", async () => {
    const result = await loadCatalogScope(active, MEMBER);
    expect(result).toMatchObject({
      status: "ok",
      scope: NO_CATALOG_SCOPE,
      catalogTruncated: false,
    });
    if (result.status !== "ok") return;
    expect(result.catalog).toEqual([
      { id: "a", name: "Flete", unitLabel: "Servicio", unitPriceClp: 10_000, isActive: true },
      { id: "b", name: "Viejo", unitLabel: "Servicio", unitPriceClp: 10_000, isActive: false },
    ]);
    // sin regla no se busca a nadie en perfiles
    expect(tables).not.toContain("profiles");
  });

  it("con regla: modo, versión, servicios y el nombre de quien la cambió", async () => {
    answers.member_catalog_scopes = {
      data: { mode: "list", revision: 3, updated_by: "u1", updated_at: "2026-11-20T15:00:00Z" },
      error: null,
    };
    answers.member_catalog_scope_items = { data: [{ catalog_item_id: "a" }], error: null };
    const result = await loadCatalogScope(active, MEMBER);
    expect(result).toMatchObject({
      status: "ok",
      scope: {
        mode: "list",
        revision: 3,
        itemIds: ["a"],
        updatedByName: "Ana Dueña",
        updatedAt: "2026-11-20T15:00:00Z",
      },
    });
  });

  it("todas las consultas van filtradas por la organización ACTIVA y por el miembro pedido", async () => {
    await loadCatalogScope(active, MEMBER);
    for (const table of ["member_catalog_scopes", "member_catalog_scope_items", "catalog_items"]) {
      expect(filters).toContainEqual([table, "tenant_id", TENANT]);
    }
    for (const table of ["member_catalog_scopes", "member_catalog_scope_items"]) {
      expect(filters).toContainEqual([table, "member_id", MEMBER]);
    }
  });

  it("a un rol al que no se le limita no se le lee el catálogo, pero sí la regla guardada", async () => {
    answers.member_catalog_scopes = {
      data: { mode: "list", revision: 1, updated_by: null, updated_at: "2026-11-20T15:00:00Z" },
      error: null,
    };
    const result = await loadCatalogScope(active, MEMBER, { withCatalog: false });
    expect(tables).not.toContain("catalog_items");
    expect(tables).toContain("member_catalog_scopes");
    expect(result).toMatchObject({ status: "ok", catalog: [], scope: { mode: "list" } });
  });

  it("un catálogo del tamaño del tope avisa que pudo cortarse", async () => {
    answers.catalog_items = {
      data: Array.from({ length: SCOPE_CATALOG_LIMIT }, (_, i) => catalogRow(`s${i}`, `S${i}`)),
      error: null,
    };
    expect(await loadCatalogScope(active, MEMBER)).toMatchObject({ catalogTruncated: true });
  });

  it("si cualquier consulta falla, error (sin detalle) y no se muestra una regla a medias", async () => {
    for (const table of ["member_catalog_scopes", "member_catalog_scope_items", "catalog_items"]) {
      const saved = answers[table];
      answers[table] = { data: null, error: { code: "XX000" } };
      expect(await loadCatalogScope(active, MEMBER), table).toEqual({ status: "error" });
      answers[table] = saved;
    }
  });

  it("si el perfil de quien cambió la regla no se puede leer, la regla igual se muestra (sin nombre)", async () => {
    answers.member_catalog_scopes = {
      data: { mode: "all", revision: 1, updated_by: "u1", updated_at: "2026-11-20T15:00:00Z" },
      error: null,
    };
    answers.profiles = { data: null, error: { code: "XX000" } };
    expect(await loadCatalogScope(active, MEMBER)).toMatchObject({
      status: "ok",
      scope: { mode: "all", revision: 1, updatedByName: null },
    });
  });
});
