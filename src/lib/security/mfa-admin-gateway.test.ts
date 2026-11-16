import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteFactor = vi.fn();
const listFactors = vi.fn();
const updateUserById = vi.fn();
vi.mock("@/lib/supabase/admin-client", () => ({
  createAdminClient: () => ({
    auth: { admin: { updateUserById, mfa: { deleteFactor, listFactors } } },
  }),
}));

const {
  MfaAdminGatewayError,
  deleteMfaFactor,
  hasVerifiedFactor,
  lockAccountAndRemoveFactors,
  removeAllFactors,
} = await import("./mfa-admin-gateway");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FACTOR_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  deleteFactor.mockReset();
  listFactors.mockReset();
  updateUserById.mockReset();
});

describe("pasarela de la API de administración de factores", () => {
  it("borra UN factor de UNA cuenta con la API de administración", async () => {
    deleteFactor.mockResolvedValue({ data: {}, error: null });
    await deleteMfaFactor(USER_ID, FACTOR_ID);
    expect(deleteFactor).toHaveBeenCalledTimes(1);
    expect(deleteFactor).toHaveBeenCalledWith({ id: FACTOR_ID, userId: USER_ID });
  });

  it("que el factor ya no exista cuenta como hecho (repetir no hace daño)", async () => {
    deleteFactor.mockResolvedValue({
      data: null,
      error: { status: 404, code: "mfa_factor_not_found" },
    });
    await expect(deleteMfaFactor(USER_ID, FACTOR_ID)).resolves.toBeUndefined();
  });

  it("cualquier otro fallo lanza un error que trae solo un código, nunca datos de la cuenta", async () => {
    deleteFactor.mockResolvedValue({
      data: null,
      error: { status: 500, code: "unexpected_failure", message: `falló para ${USER_ID}` },
    });
    const error = await deleteMfaFactor(USER_ID, FACTOR_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MfaAdminGatewayError);
    expect((error as Error).message).toBe("mfa_admin_gateway_delete_factor:unexpected_failure");
    expect((error as Error).message).not.toContain(USER_ID);
    deleteFactor.mockResolvedValue({ data: null, error: { status: 502 } });
    const second = await deleteMfaFactor(USER_ID, FACTOR_ID).catch((cause: unknown) => cause);
    expect((second as Error).message).toBe("mfa_admin_gateway_delete_factor:502");
  });
});

describe("quitar todos los factores sin tocar la contraseña (H-004b)", () => {
  const OTHER_FACTOR_ID = "33333333-3333-4333-8333-333333333333";

  it("lista los factores de la cuenta y borra cada uno, sin cambiar la contraseña ni cerrar sesiones", async () => {
    listFactors.mockResolvedValue({
      data: { factors: [{ id: FACTOR_ID }, { id: OTHER_FACTOR_ID }] },
      error: null,
    });
    deleteFactor.mockResolvedValue({ data: {}, error: null });
    await removeAllFactors(USER_ID);
    expect(listFactors).toHaveBeenCalledWith({ userId: USER_ID });
    expect(deleteFactor).toHaveBeenCalledTimes(2);
    expect(deleteFactor).toHaveBeenCalledWith({ id: FACTOR_ID, userId: USER_ID });
    expect(deleteFactor).toHaveBeenCalledWith({ id: OTHER_FACTOR_ID, userId: USER_ID });
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("sin factores no hace nada, y un factor que ya no existe cuenta como hecho", async () => {
    listFactors.mockResolvedValue({ data: { factors: [] }, error: null });
    await expect(removeAllFactors(USER_ID)).resolves.toBeUndefined();
    expect(deleteFactor).not.toHaveBeenCalled();
    listFactors.mockResolvedValue({ data: { factors: [{ id: FACTOR_ID }] }, error: null });
    deleteFactor.mockResolvedValue({ data: null, error: { status: 404 } });
    await expect(removeAllFactors(USER_ID)).resolves.toBeUndefined();
  });

  it("si no puede listar o borrar, lanza un error que trae solo un código", async () => {
    listFactors.mockResolvedValue({
      data: null,
      error: { status: 500, code: "unexpected_failure" },
    });
    const listing = await removeAllFactors(USER_ID).catch((cause: unknown) => cause);
    expect(listing).toBeInstanceOf(MfaAdminGatewayError);
    expect((listing as Error).message).toBe("mfa_admin_gateway_list_factors:unexpected_failure");
    listFactors.mockResolvedValue({ data: { factors: [{ id: FACTOR_ID }] }, error: null });
    deleteFactor.mockResolvedValue({ data: null, error: { status: 502 } });
    const deleting = await removeAllFactors(USER_ID).catch((cause: unknown) => cause);
    expect((deleting as Error).message).toBe("mfa_admin_gateway_delete_factor:502");
    expect((deleting as Error).message).not.toContain(USER_ID);
  });

  it("anular (lockAccountAndRemoveFactors) sigue cambiando la contraseña antes de quitar los factores", async () => {
    updateUserById.mockResolvedValue({ data: {}, error: null });
    listFactors.mockResolvedValue({ data: { factors: [{ id: FACTOR_ID }] }, error: null });
    deleteFactor.mockResolvedValue({ data: {}, error: null });
    await lockAccountAndRemoveFactors(USER_ID);
    expect(updateUserById).toHaveBeenCalledTimes(1);
    expect(updateUserById.mock.calls[0][0]).toBe(USER_ID);
    expect(updateUserById.mock.invocationCallOrder[0]).toBeLessThan(
      listFactors.mock.invocationCallOrder[0],
    );
    expect(deleteFactor).toHaveBeenCalledWith({ id: FACTOR_ID, userId: USER_ID });
    // Si falla el cambio de contraseña, no se llega a tocar los factores.
    updateUserById.mockResolvedValue({ data: null, error: { status: 500, code: "boom" } });
    listFactors.mockClear();
    await expect(lockAccountAndRemoveFactors(USER_ID)).rejects.toThrow(
      "mfa_admin_gateway_lock_password:boom",
    );
    expect(listFactors).not.toHaveBeenCalled();
  });
});

describe("¿le queda algún factor verificado? (H-004b, corrección C1)", () => {
  it("responde que sí si hay un factor verificado, de cualquier tipo", async () => {
    listFactors.mockResolvedValue({
      data: {
        factors: [
          { id: FACTOR_ID, status: "unverified" },
          { id: "x", status: "verified" },
        ],
      },
      error: null,
    });
    await expect(hasVerifiedFactor(USER_ID)).resolves.toBe(true);
    expect(listFactors).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it("responde que no sin factores o solo con factores sin verificar", async () => {
    listFactors.mockResolvedValue({ data: { factors: [] }, error: null });
    await expect(hasVerifiedFactor(USER_ID)).resolves.toBe(false);
    listFactors.mockResolvedValue({
      data: { factors: [{ id: FACTOR_ID, status: "unverified" }] },
      error: null,
    });
    await expect(hasVerifiedFactor(USER_ID)).resolves.toBe(false);
  });

  it("si no puede listar, lanza un error que trae solo un código (no se puede afirmar que no queda)", async () => {
    listFactors.mockResolvedValue({ data: null, error: { status: 500, code: "boom" } });
    const error = await hasVerifiedFactor(USER_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MfaAdminGatewayError);
    expect((error as Error).message).toBe("mfa_admin_gateway_list_factors:boom");
    expect((error as Error).message).not.toContain(USER_ID);
  });

  it("no borra nada ni cambia la contraseña: solo lee", async () => {
    listFactors.mockResolvedValue({ data: { factors: [] }, error: null });
    await hasVerifiedFactor(USER_ID);
    expect(deleteFactor).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });
});
