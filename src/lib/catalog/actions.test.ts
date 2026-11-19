import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_ROLES, NO_PERMISSION_MESSAGE, can } from "@/lib/permissions/matrix";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";

// Las acciones del catálogo con un falso miembro de cada rol (H-041: la casilla «Bloquear el precio»): quien no maneja el
// catálogo recibe el mensaje único y la base NI SE CONSULTA; quien sí, manda `price_locked` según la casilla.

const TENANT_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0001";
const ITEM_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0099";
const insert = vi.fn();
const update = vi.fn();
const from = vi.fn();
const revalidatePath = vi.fn();
let role = "owner";

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("@/lib/tenant/active-tenant", () => ({
  requireActiveTenant: vi.fn(async () => ({
    tenantId: TENANT_ID,
    role,
    userId: "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0002",
    supabase: { from },
  })),
}));

const { createCatalogItemAction, updateCatalogItemAction } = await import("./actions");

beforeEach(() => {
  role = "owner";
  for (const mock of [insert, update, from, revalidatePath]) mock.mockReset();
  insert.mockResolvedValue({ error: null });
  update.mockReturnValue({
    eq: () => ({ select: async () => ({ data: [{ id: ITEM_ID }], error: null }) }),
  });
  from.mockReturnValue({ insert, update });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function form(over: Record<string, string> = {}): FormData {
  const data = new FormData();
  const fields = {
    name: "Flete Santiago",
    description: "",
    unit: "service",
    unitPriceClp: "10.000",
    taxTreatment: "taxable",
    ...over,
  };
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}
const create = (data: FormData) => createCatalogItemAction(TENANT_ID, INITIAL_FORM_STATE, data);
const edit = (data: FormData) =>
  updateCatalogItemAction(TENANT_ID, ITEM_ID, INITIAL_FORM_STATE, data);

describe("quien no maneja el catálogo no llega a la base", () => {
  const without = MEMBER_ROLES.filter((r) => !can(r, "catalog.manage"));

  it("son Aprobador, Comercial y Observador", () => {
    expect(without).toHaveLength(3);
  });

  it.each(without)("%s: no puede agregar ni cambiar el candado", async (r) => {
    role = r;
    for (const result of [
      await create(form({ priceLocked: "1" })),
      await edit(form({ priceLocked: "1" })),
    ]) {
      expect(result).toMatchObject({ status: "error", message: NO_PERMISSION_MESSAGE });
    }
    expect(from).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("quien maneja el catálogo bloquea el precio", () => {
  const with_ = MEMBER_ROLES.filter((r) => can(r, "catalog.manage"));

  it.each(with_)("%s: la casilla marcada guarda price_locked verdadero", async (r) => {
    role = r;
    expect((await create(form({ priceLocked: "1" }))).status).toBe("sent");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ price_locked: true }));
    expect((await edit(form({ priceLocked: "1" }))).status).toBe("sent");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ price_locked: true }));
  });

  it("sin marcar la casilla guarda price_locked falso (también al desbloquear)", async () => {
    await create(form());
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ price_locked: false }));
    await edit(form());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ price_locked: false }));
  });

  it("un valor raro en la casilla se rechaza antes de la base y devuelve lo escrito", async () => {
    const result = await create(form({ priceLocked: "si" }));
    expect(result.status).toBe("error");
    expect(result.fieldErrors).toHaveProperty("priceLocked");
    expect(result.values).toMatchObject({ priceLocked: "si", name: "Flete Santiago" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("una base que dice «sin permiso» (42501) da el mensaje único", async () => {
    insert.mockResolvedValue({ error: { code: "42501", message: "x" } });
    expect(await create(form({ priceLocked: "1" }))).toMatchObject({
      status: "error",
      message: NO_PERMISSION_MESSAGE,
    });
  });
});
