import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_ROLES, NO_PERMISSION_MESSAGE, can } from "@/lib/permissions/matrix";

// Fijar el descuento máximo de los Comerciales (H-041) con un falso miembro de cada rol: quien no maneja el catálogo recibe el
// mensaje único y la base NI SE CONSULTA; quien sí llega a `set_quote_max_discount` con el valor ya validado.

const TENANT_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0001";
const rpc = vi.fn();
const revalidatePath = vi.fn();
let role = "owner";

vi.mock("next/cache", () => ({
  revalidatePath: (path: string, type?: string) => revalidatePath(path, type),
}));
vi.mock("@/lib/tenant/active-tenant", () => ({
  requireActiveTenant: vi.fn(async () => ({
    tenantId: TENANT_ID,
    role,
    userId: "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0002",
    supabase: { rpc },
  })),
}));

const { saveDiscountCapAction } = await import("./discount-cap-actions");
const messages = await import("./discount-cap-messages");

const logged: string[] = [];
beforeEach(() => {
  role = "owner";
  rpc.mockReset();
  revalidatePath.mockReset();
  logged.length = 0;
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

describe("quien no maneja el catálogo no llega a la base", () => {
  const without = MEMBER_ROLES.filter((r) => !can(r, "catalog.manage"));

  it("son Aprobador, Comercial y Observador", () => {
    expect(without).toHaveLength(3);
  });

  it.each(without)("%s: «sin permiso» y no se consulta nada", async (r) => {
    role = r;
    expect(await saveDiscountCapAction(TENANT_ID, 1_000)).toEqual({
      status: "error",
      message: NO_PERMISSION_MESSAGE,
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("quien maneja el catálogo fija el descuento máximo", () => {
  it.each(MEMBER_ROLES.filter((r) => can(r, "catalog.manage")))(
    "%s llega a set_quote_max_discount con el valor leído",
    async (r) => {
      role = r;
      rpc.mockResolvedValue({ data: { changed: true, max_discount_bp: 1_000 }, error: null });
      const result = await saveDiscountCapAction(TENANT_ID, 1_000);
      expect(rpc).toHaveBeenCalledWith("set_quote_max_discount", { p_max_bp: 1_000 });
      expect(result).toEqual({
        status: "ok",
        message: messages.DISCOUNT_CAP_SAVED_MESSAGE,
        maxDiscountBp: 1_000,
      });
      expect(revalidatePath).toHaveBeenCalledWith(`/o/${TENANT_ID}/catalogo`, "layout");
      expect(revalidatePath).toHaveBeenCalledWith(`/o/${TENANT_ID}/cotizaciones`, "layout");
    },
  );

  it("vacío (sin tope) y 0 son valores válidos", async () => {
    rpc.mockResolvedValueOnce({ data: { changed: true, max_discount_bp: null }, error: null });
    expect(await saveDiscountCapAction(TENANT_ID, null)).toMatchObject({
      status: "ok",
      maxDiscountBp: null,
    });
    expect(rpc).toHaveBeenLastCalledWith("set_quote_max_discount", { p_max_bp: null });
    rpc.mockResolvedValueOnce({ data: { changed: true, max_discount_bp: 0 }, error: null });
    expect(await saveDiscountCapAction(TENANT_ID, 0)).toMatchObject({
      status: "ok",
      maxDiscountBp: 0,
    });
  });

  it("guardar lo mismo no es un error: se dice que no hubo cambios", async () => {
    rpc.mockResolvedValue({ data: { changed: false, max_discount_bp: 500 }, error: null });
    expect(await saveDiscountCapAction(TENANT_ID, 500)).toMatchObject({
      status: "ok",
      message: messages.DISCOUNT_CAP_UNCHANGED_MESSAGE,
    });
  });

  it.each([10_000, -1, 12.5, Number.NaN, "1000", undefined])(
    "el valor %j se rechaza antes de llamar a la base",
    async (value) => {
      expect(await saveDiscountCapAction(TENANT_ID, value as number)).toEqual({
        status: "error",
        message: messages.DISCOUNT_CAP_INVALID_MESSAGE,
      });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("42501 de la base da el mensaje único; CP422 dice que el valor no sirve", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "forbidden" } });
    expect(await saveDiscountCapAction(TENANT_ID, 1_000)).toMatchObject({
      message: NO_PERMISSION_MESSAGE,
    });
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "CP422", message: "invalid_max_discount" },
    });
    expect(await saveDiscountCapAction(TENANT_ID, 1_000)).toMatchObject({
      message: messages.DISCOUNT_CAP_INVALID_MESSAGE,
    });
  });

  it("un fallo inesperado se dice sin detalle técnico y solo se registra el código", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "secreto interno" } });
    expect(await saveDiscountCapAction(TENANT_ID, 1_000)).toEqual({
      status: "error",
      message: messages.DISCOUNT_CAP_GENERIC_FAILURE,
    });
    expect(logged.join(" ")).toContain("XX000");
    expect(logged.join(" ")).not.toContain("secreto interno");
  });

  it("una respuesta con otra forma no se da por buena", async () => {
    rpc.mockResolvedValue({ data: { changed: "sí" }, error: null });
    expect(await saveDiscountCapAction(TENANT_ID, 1_000)).toMatchObject({
      status: "error",
      message: messages.DISCOUNT_CAP_GENERIC_FAILURE,
    });
  });
});
