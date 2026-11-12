import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteFactor = vi.fn();
vi.mock("@/lib/supabase/admin-client", () => ({
  createAdminClient: () => ({ auth: { admin: { mfa: { deleteFactor } } } }),
}));

const { MfaAdminGatewayError, deleteMfaFactor } = await import("./mfa-admin-gateway");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FACTOR_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => deleteFactor.mockReset());

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
