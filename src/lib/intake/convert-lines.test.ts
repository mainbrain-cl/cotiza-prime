import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";

// Convertir una solicitud en cotización (H-090) con la regla de servicios por comercial (H-042): el catálogo se lee por
// `quotable_catalog_items`, así que un servicio que la regla no le permite a quien convierte NO entra al mapa y queda entre los «no
// cargados», en vez de hacer fallar el guardado entero y dejar la cotización vacía.
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn(async () => {}) }));
vi.mock("@/lib/quotes/actions", () => ({ saveQuoteDraftAction: vi.fn() }));

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

const { loadActiveCatalog, planRequestLines } = await import("./convert-lines");
const { QUOTABLE_IDS_LIMIT } = await import("@/lib/quotes/catalog-limits");

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (id: string) => ({
  id,
  name: `Servicio ${id}`,
  description: null,
  unit: "service",
  unit_price_clp: 5_000,
  tax_treatment: "taxable",
  price_locked: true,
});

beforeEach(() => {
  calls.length = 0;
  answers = [];
  rpc.mockClear();
  from.mockClear();
});

describe("loadActiveCatalog", () => {
  it("lee por `quotable_catalog_items` los servicios pedidos y arma el mapa con el formato de la conversión", async () => {
    answers = [{ data: [row(uuid(1))], error: null }];
    const map = await loadActiveCatalog(active, [uuid(1), uuid(1), uuid(2)]);
    expect(calls).toEqual([
      ["quotable_catalog_items", { p_search: "", p_ids: [uuid(1), uuid(2)] }],
    ]);
    expect(map?.get(uuid(1))).toEqual({
      id: uuid(1),
      name: `Servicio ${uuid(1)}`,
      description: null,
      unit: "service",
      unitPriceClp: 5_000,
      taxTreatment: "taxable",
      priceLocked: true,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("un servicio que la regla no permite (la base no lo devuelve) no entra al mapa", async () => {
    answers = [{ data: [row(uuid(1))], error: null }];
    const map = await loadActiveCatalog(active, [uuid(1), uuid(2)]);
    expect(map?.has(uuid(1))).toBe(true);
    expect(map?.has(uuid(2))).toBe(false);
  });

  it("sin identificadores no consulta nada", async () => {
    expect((await loadActiveCatalog(active, []))?.size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("pide de a 200 identificadores y junta las respuestas", async () => {
    const ids = Array.from({ length: QUOTABLE_IDS_LIMIT + 3 }, (_, i) => uuid(i + 1));
    answers = [
      { data: [row(ids[0])], error: null },
      { data: [row(ids[QUOTABLE_IDS_LIMIT + 2])], error: null },
    ];
    const map = await loadActiveCatalog(active, ids);
    expect(calls).toHaveLength(2);
    expect((calls[0][1] as { p_ids: string[] }).p_ids).toHaveLength(QUOTABLE_IDS_LIMIT);
    expect((calls[1][1] as { p_ids: string[] }).p_ids).toHaveLength(3);
    expect([...(map ?? new Map()).keys()]).toEqual([ids[0], ids[QUOTABLE_IDS_LIMIT + 2]]);
  });

  it("si la base falla en cualquiera de las consultas, null (no se carga un catálogo a medias)", async () => {
    const ids = Array.from({ length: QUOTABLE_IDS_LIMIT + 1 }, (_, i) => uuid(i + 1));
    answers = [
      { data: [row(ids[0])], error: null },
      { data: null, error: { code: "XX000" } },
    ];
    expect(await loadActiveCatalog(active, ids)).toBeNull();
  });
});

describe("planRequestLines", () => {
  it("un servicio pedido que la regla no permite queda entre los «no cargados» y no hace fallar el plan", async () => {
    answers = [{ data: [row(uuid(1))], error: null }];
    const plan = await planRequestLines(active, [
      { catalogItemId: uuid(1), name: "Permitido", unit: "service", quantityMilli: 1_000 },
      { catalogItemId: uuid(2), name: "No permitido", unit: "service", quantityMilli: 1_000 },
    ] as never);
    expect(plan?.lines.map((l) => l.catalog.id)).toEqual([uuid(1)]);
    expect(plan?.skipped.map((s) => s.name)).toEqual(["No permitido"]);
  });
});
