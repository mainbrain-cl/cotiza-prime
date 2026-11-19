import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_ROLES, canEver } from "@/lib/permissions/matrix";

// Leer UN servicio del catálogo para poner al día una línea (H-041). Con un falso miembro de cada rol: quien no puede editar
// cotizaciones, un identificador que no es UUID y un servicio de otra organización NO llegan a revelar nada; la organización sale
// SIEMPRE de la activa, nunca del identificador que manda la pantalla.

const TENANT_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0001";
const OTHER_TENANT_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0099";
const ITEM_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0010";
let role = "sales";

const filters: Array<[string, unknown]> = [];
let selected = "";
let answer: { data: unknown; error: { code: string } | null } = { data: null, error: null };
const from = vi.fn((table: string) => {
  filters.push(["from", table]);
  const builder = {
    select: (columns: string) => {
      selected = columns;
      return builder;
    },
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    maybeSingle: async () => answer,
  };
  return builder;
});

vi.mock("@/lib/tenant/active-tenant", () => ({
  requireActiveTenant: vi.fn(async () => ({
    tenantId: TENANT_ID,
    role,
    userId: "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0002",
    supabase: { from },
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
  filters.length = 0;
  selected = "";
  from.mockClear();
  answer = { data: row, error: null };
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
    expect(from).not.toHaveBeenCalled();
  });

  it.each(["", "no-es-uuid", "1; drop table catalog_items", ITEM_ID + "x"])(
    "un identificador que no es UUID («%s») no llega a la base",
    async (bad) => {
      expect(await getQuoteCatalogItemAction(TENANT_ID, bad)).toEqual({ status: "missing" });
      expect(from).not.toHaveBeenCalled();
    },
  );

  it("un valor que ni siquiera es texto tampoco", async () => {
    expect(
      await getQuoteCatalogItemAction(TENANT_ID, { id: ITEM_ID } as unknown as string),
    ).toEqual({ status: "missing" });
    expect(from).not.toHaveBeenCalled();
  });

  it("filtra por la organización ACTIVA, solo activos y trae las mismas columnas que el buscador (sin costos ni notas)", async () => {
    // La pantalla manda OTRA organización: la activa la decide el servidor.
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
    expect(filters).toEqual([
      ["from", "catalog_items"],
      ["tenant_id", TENANT_ID],
      ["id", ITEM_ID],
      ["is_active", true],
    ]);
    expect(selected).toBe(
      "id, name, description, unit, unit_price_clp, tax_treatment, price_locked",
    );
    expect(filters.some(([, value]) => value === OTHER_TENANT_ID)).toBe(false);
  });

  it("un servicio que no existe, está desactivado o es de otra organización da lo mismo: «missing»", async () => {
    answer = { data: null, error: null };
    expect(await getQuoteCatalogItemAction(TENANT_ID, ITEM_ID)).toEqual({ status: "missing" });
  });

  it("si la base falla, «failed» (distinto de «missing») y sin detalle", async () => {
    answer = { data: null, error: { code: "XX000" } };
    expect(await getQuoteCatalogItemAction(TENANT_ID, ITEM_ID)).toEqual({ status: "failed" });
  });
});
