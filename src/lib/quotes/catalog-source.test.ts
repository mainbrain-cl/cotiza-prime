import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";

// Los lectores del catálogo del cotizador (H-042): la lista, un servicio, «mis servicios» y las líneas que ya no se pueden cotizar. Todos
// pasan por funciones de la base (`quotable_catalog_items` y `my_catalog_scope`), que aplican la regla de servicios por comercial.
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn(async () => {}) }));

const calls: Array<[string, unknown]> = [];
let answers: Array<{ data: unknown; error: { code: string } | null }> = [];
const rpc = vi.fn(async (name: string, args?: unknown) => {
  calls.push([name, args]);
  return answers.shift() ?? { data: [], error: null };
});
const from = vi.fn(() => {
  throw new Error("no se lee catalog_items directo");
});
const active = { tenantId: "t", role: "sales", supabase: { rpc, from } } as unknown as ActiveTenant;

const {
  getQuotableCatalogItem,
  listNotAllowedCatalogIds,
  listQuotableCatalogItems,
  loadMyCatalogScope,
  QUOTABLE_CATALOG_LIMIT,
  QUOTABLE_SEARCH_MAX_LENGTH,
} = await import("./catalog-source");
const { QUOTABLE_IDS_LIMIT } = await import("./catalog-limits");

const row = (id: string) => ({
  id,
  name: `Servicio ${id}`,
  description: null,
  unit: "service",
  unit_price_clp: 1_000,
  tax_treatment: "taxable",
  price_locked: false,
});
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => {
  calls.length = 0;
  answers = [];
  rpc.mockClear();
  from.mockClear();
});

describe("listQuotableCatalogItems", () => {
  it("pide la lista a la base con la búsqueda recortada y entrega los servicios con el formato de la aplicación", async () => {
    answers = [{ data: [row(uuid(1))], error: null }];
    const items = await listQuotableCatalogItems(active, `  ${"x".repeat(150)}  `);
    expect(calls).toEqual([
      ["quotable_catalog_items", { p_search: "x".repeat(QUOTABLE_SEARCH_MAX_LENGTH), p_ids: null }],
    ]);
    expect(items).toEqual([
      {
        id: uuid(1),
        name: `Servicio ${uuid(1)}`,
        description: null,
        unit: "service",
        unitPriceClp: 1_000,
        taxTreatment: "taxable",
        priceLocked: false,
      },
    ]);
    expect(from).not.toHaveBeenCalled();
  });
  it("si la base falla, devuelve una lista vacía", async () => {
    answers = [{ data: null, error: { code: "XX000" } }];
    expect(await listQuotableCatalogItems(active, "")).toEqual([]);
  });
  it("el tope de resultados es el de la base (20)", () => {
    expect(QUOTABLE_CATALOG_LIMIT).toBe(20);
  });
});

describe("loadMyCatalogScope", () => {
  it("entrega si hay límite y cuántos servicios activos puede cotizar", async () => {
    answers = [{ data: { limited: true, allowed_count: 3 }, error: null }];
    expect(await loadMyCatalogScope(active)).toEqual({ limited: true, allowedCount: 3 });
    expect(calls).toEqual([["my_catalog_scope", undefined]]);
    answers = [{ data: { limited: false, allowed_count: null }, error: null }];
    expect(await loadMyCatalogScope(active)).toEqual({ limited: false, allowedCount: null });
  });
  it("si no se puede leer o llega con otra forma, devuelve null (la pantalla no afirma nada)", async () => {
    answers = [{ data: null, error: { code: "XX000" } }];
    expect(await loadMyCatalogScope(active)).toBeNull();
    answers = [{ data: { limited: "sí" }, error: null }];
    expect(await loadMyCatalogScope(active)).toBeNull();
  });
});

describe("listNotAllowedCatalogIds", () => {
  it("devuelve los servicios que la base no ofrece, sin repetidos y en el orden pedido", async () => {
    answers = [{ data: [row(uuid(1)), row(uuid(3))], error: null }];
    expect(
      await listNotAllowedCatalogIds(active, [uuid(1), uuid(2), uuid(3), uuid(2), uuid(4)]),
    ).toEqual([uuid(2), uuid(4)]);
    expect(calls).toEqual([
      ["quotable_catalog_items", { p_search: "", p_ids: [uuid(1), uuid(2), uuid(3), uuid(4)] }],
    ]);
  });
  it("sin servicios no consulta nada", async () => {
    expect(await listNotAllowedCatalogIds(active, [])).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("de a 200 identificadores por consulta", async () => {
    const ids = Array.from({ length: QUOTABLE_IDS_LIMIT + 5 }, (_, i) => uuid(i + 1));
    answers = [
      { data: ids.slice(0, QUOTABLE_IDS_LIMIT).map(row), error: null },
      { data: [], error: null },
    ];
    const notAllowed = await listNotAllowedCatalogIds(active, ids);
    expect(calls).toHaveLength(2);
    expect((calls[0][1] as { p_ids: string[] }).p_ids).toHaveLength(QUOTABLE_IDS_LIMIT);
    expect((calls[1][1] as { p_ids: string[] }).p_ids).toHaveLength(5);
    expect(notAllowed).toEqual(ids.slice(QUOTABLE_IDS_LIMIT));
  });
  it("si la base falla, null (no se afirma que algo sea o no sea permitido)", async () => {
    answers = [{ data: null, error: { code: "XX000" } }];
    expect(await listNotAllowedCatalogIds(active, [uuid(1)])).toBeNull();
  });
});

describe("getQuotableCatalogItem", () => {
  it("pide ese servicio por identificador", async () => {
    answers = [{ data: [row(uuid(7))], error: null }];
    expect(await getQuotableCatalogItem(active, uuid(7))).toMatchObject({ status: "found" });
    expect(calls).toEqual([["quotable_catalog_items", { p_search: "", p_ids: [uuid(7)] }]]);
  });
});
