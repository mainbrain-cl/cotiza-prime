import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_ROLES, canEver } from "@/lib/permissions/matrix";

// Leer UN servicio del catálogo para poner al día una línea (H-041). Con un falso miembro de cada rol: quien no puede editar
// cotizaciones, un identificador que no es UUID y un servicio de otra organización NO llegan a revelar nada; la organización sale
// SIEMPRE de la activa, nunca del identificador que manda la pantalla.

const TENANT_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0001";
const OTHER_TENANT_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0099";
const ITEM_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0010";
let role = "sales";

const calls: Array<[string, unknown]> = [];
let answer: { data: unknown; error: { code: string } | null } = { data: null, error: null };
const rpc = vi.fn(async (name: string, args: unknown) => {
  calls.push([name, args]);
  return answer;
});
// La aplicación ya no lee `catalog_items` directo para ofrecer servicios (H-042): si lo hiciera, esta prueba cae.
const from = vi.fn(() => {
  throw new Error("el lector del catálogo no debe leer catalog_items directo");
});

vi.mock("@/lib/tenant/active-tenant", () => ({
  requireActiveTenant: vi.fn(async () => ({
    tenantId: TENANT_ID,
    role,
    userId: "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0002",
    supabase: { from, rpc },
  })),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn(async () => {}) }));

const { getQuoteCatalogItemAction } = await import("./actions");

const row = {
  id: ITEM_ID,
  name: "Flete Santiago",
  description: null,
  unit: "service",
  unit_price_clp: 12_000,
  tax_treatment: "taxable",
  price_locked: true,
};

beforeEach(() => {
  role = "sales";
  calls.length = 0;
  from.mockClear();
  rpc.mockClear();
  answer = { data: [row], error: null };
});

describe("getQuoteCatalogItemAction", () => {
  // «quote.edit» es de quien lo creó (`own`): la acción hace la revisión gruesa (¿puede editar alguna?), y que sea SU borrador lo exige la base.
  const cannotEdit = MEMBER_ROLES.filter((r) => !canEver(r, "quote.edit"));

  it("quien no edita cotizaciones (Aprobador y Observador) no consulta nada", () => {
    expect(cannotEdit.length).toBeGreaterThan(0);
  });

  it.each(cannotEdit)("%s: «missing» y la base no se toca", async (r) => {
    role = r;
    expect(await getQuoteCatalogItemAction(TENANT_ID, ITEM_ID)).toEqual({ status: "missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["", "no-es-uuid", "1; drop table catalog_items", ITEM_ID + "x"])(
    "un identificador que no es UUID («%s») no llega a la base",
    async (bad) => {
      expect(await getQuoteCatalogItemAction(TENANT_ID, bad)).toEqual({ status: "missing" });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("un valor que ni siquiera es texto tampoco", async () => {
    expect(
      await getQuoteCatalogItemAction(TENANT_ID, { id: ITEM_ID } as unknown as string),
    ).toEqual({ status: "missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("lee UN servicio por `quotable_catalog_items` (la regla de servicios por comercial la aplica la base) y no toca `catalog_items`", async () => {
    // La pantalla manda OTRA organización: la activa la decide el servidor (la función de la base tampoco recibe ninguna).
    const result = await getQuoteCatalogItemAction(OTHER_TENANT_ID, ITEM_ID);
    expect(result).toEqual({
      status: "found",
      item: {
        id: ITEM_ID,
        name: "Flete Santiago",
        description: null,
        unit: "service",
        unitPriceClp: 12_000,
        taxTreatment: "taxable",
        priceLocked: true,
      },
    });
    expect(calls).toEqual([["quotable_catalog_items", { p_search: "", p_ids: [ITEM_ID] }]]);
    expect(JSON.stringify(calls)).not.toContain(OTHER_TENANT_ID);
    expect(JSON.stringify(calls)).not.toContain(TENANT_ID);
    expect(from).not.toHaveBeenCalled();
  });

  it("un servicio que no existe, está desactivado, es de otra organización o la regla no permite da lo mismo: «missing»", async () => {
    answer = { data: [], error: null };
    expect(await getQuoteCatalogItemAction(TENANT_ID, ITEM_ID)).toEqual({ status: "missing" });
    answer = { data: null, error: null };
    expect(await getQuoteCatalogItemAction(TENANT_ID, ITEM_ID)).toEqual({ status: "missing" });
  });

  it("si la base falla, «failed» (distinto de «missing») y sin detalle", async () => {
    answer = { data: null, error: { code: "XX000" } };
    expect(await getQuoteCatalogItemAction(TENANT_ID, ITEM_ID)).toEqual({ status: "failed" });
  });
});
