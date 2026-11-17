import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin-client", () => ({ createAdminClient: () => ({ rpc }) }));

const {
  MfaRecoveryGatewayError,
  acknowledgeRecoveryCodes,
  claimRecoveryCode,
  completeRecoveryCode,
  getRecoveryCodesStatus,
  releaseRecoveryCode,
  replaceRecoveryCodes,
  revokeRecoveryCodes,
} = await import("./mfa-recovery-gateway");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FACTOR_ID = "22222222-2222-4222-8222-222222222222";
const SET_ID = "33333333-3333-4333-8333-333333333333";
const CODE_ID = "44444444-4444-4444-8444-444444444444";
const HASHES = Array.from({ length: 10 }, (_, index) => String(index).repeat(64));

beforeEach(() => rpc.mockReset());

describe("portero de los códigos de respaldo: reemplazar el juego", () => {
  it("llama a mfa_recovery_codes_replace con la cuenta, el factor y las 10 huellas, y entrega el juego nuevo", async () => {
    rpc.mockResolvedValue({ data: { result: "ok", set_id: SET_ID, total: 10 }, error: null });
    expect(await replaceRecoveryCodes(USER_ID, FACTOR_ID, HASHES)).toEqual({
      result: "ok",
      setId: SET_ID,
      total: 10,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("mfa_recovery_codes_replace", {
      p_user_id: USER_ID,
      p_factor_id: FACTOR_ID,
      p_code_hashes: HASHES,
    });
  });

  it("`no_factor` y `busy` pasan tal cual; una respuesta rara es un error de forma", async () => {
    rpc.mockResolvedValue({ data: { result: "no_factor" }, error: null });
    expect(await replaceRecoveryCodes(USER_ID, FACTOR_ID, HASHES)).toEqual({ result: "no_factor" });
    rpc.mockResolvedValue({ data: { result: "busy" }, error: null });
    expect(await replaceRecoveryCodes(USER_ID, FACTOR_ID, HASHES)).toEqual({ result: "busy" });
    for (const data of [
      null,
      { result: "ok" },
      { result: "ok", set_id: "no-uuid", total: 10 },
      { result: "ok", set_id: SET_ID, total: 0 },
      { result: "otra-cosa" },
    ]) {
      rpc.mockResolvedValue({ data, error: null });
      await expect(replaceRecoveryCodes(USER_ID, FACTOR_ID, HASHES)).rejects.toThrow(
        "mfa_recovery_gateway_replace:shape",
      );
    }
  });

  it("el error de la base (huellas mal formadas) trae solo el código de Postgres", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "CP422", message: `falló para ${USER_ID}` },
    });
    const error = await replaceRecoveryCodes(USER_ID, FACTOR_ID, HASHES).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(MfaRecoveryGatewayError);
    expect((error as Error).message).toBe("mfa_recovery_gateway_replace:CP422");
    expect((error as Error).message).not.toContain(USER_ID);
    expect((error as InstanceType<typeof MfaRecoveryGatewayError>).code).toBe("CP422");
  });
});

describe("portero de los códigos de respaldo: tomar, completar y soltar", () => {
  it("tomar entrega el código y su factor; `invalid` es null, sin distinguir el motivo", async () => {
    rpc.mockResolvedValue({
      data: { result: "ok", code_id: CODE_ID, factor_id: FACTOR_ID },
      error: null,
    });
    expect(await claimRecoveryCode(USER_ID, HASHES[0])).toEqual({
      codeId: CODE_ID,
      factorId: FACTOR_ID,
    });
    expect(rpc).toHaveBeenCalledWith("mfa_recovery_code_claim", {
      p_user_id: USER_ID,
      p_code_hash: HASHES[0],
    });
    rpc.mockResolvedValue({ data: { result: "invalid" }, error: null });
    expect(await claimRecoveryCode(USER_ID, HASHES[0])).toBeNull();
    rpc.mockResolvedValue({ data: { result: "ok", code_id: "no-uuid" }, error: null });
    await expect(claimRecoveryCode(USER_ID, HASHES[0])).rejects.toThrow(
      "mfa_recovery_gateway_claim:shape",
    );
    rpc.mockResolvedValue({ data: null, error: { code: "57014" } });
    await expect(claimRecoveryCode(USER_ID, HASHES[0])).rejects.toThrow(
      "mfa_recovery_gateway_claim:57014",
    );
  });

  it("tomar no se repite solo ante un error (no es repetible)", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "08006" } });
    await expect(claimRecoveryCode(USER_ID, HASHES[0])).rejects.toBeInstanceOf(
      MfaRecoveryGatewayError,
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("completar entrega el correo de la cuenta (o null sin correo) y `invalid` es null", async () => {
    rpc.mockResolvedValue({ data: { result: "ok", email: "ana@ejemplo.test" }, error: null });
    expect(await completeRecoveryCode(CODE_ID)).toEqual({ email: "ana@ejemplo.test" });
    expect(rpc).toHaveBeenCalledWith("mfa_recovery_code_complete", { p_code_id: CODE_ID });
    rpc.mockResolvedValue({ data: { result: "ok", email: null }, error: null });
    expect(await completeRecoveryCode(CODE_ID)).toEqual({ email: null });
    rpc.mockResolvedValue({ data: { result: "invalid" }, error: null });
    expect(await completeRecoveryCode(CODE_ID)).toBeNull();
    rpc.mockResolvedValue({ data: { result: "ok" }, error: null });
    await expect(completeRecoveryCode(CODE_ID)).rejects.toThrow(
      "mfa_recovery_gateway_complete:shape",
    );
    rpc.mockResolvedValue({ data: null, error: { code: "CP422" } });
    await expect(completeRecoveryCode(CODE_ID)).rejects.toThrow(
      "mfa_recovery_gateway_complete:CP422",
    );
  });

  it("soltar y «los guardé» devuelven lo que dice la base, y un valor que no es verdadero o falso es un error de forma", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await releaseRecoveryCode(CODE_ID)).toBe(true);
    expect(rpc).toHaveBeenCalledWith("mfa_recovery_code_release", { p_code_id: CODE_ID });
    expect(await acknowledgeRecoveryCodes(USER_ID, SET_ID)).toBe(true);
    expect(rpc).toHaveBeenCalledWith("mfa_recovery_codes_acknowledge", {
      p_user_id: USER_ID,
      p_set_id: SET_ID,
    });
    rpc.mockResolvedValue({ data: false, error: null });
    expect(await releaseRecoveryCode(CODE_ID)).toBe(false);
    expect(await acknowledgeRecoveryCodes(USER_ID, SET_ID)).toBe(false);
    rpc.mockResolvedValue({ data: "true", error: null });
    await expect(releaseRecoveryCode(CODE_ID)).rejects.toThrow(
      "mfa_recovery_gateway_release:shape",
    );
    await expect(acknowledgeRecoveryCodes(USER_ID, SET_ID)).rejects.toThrow(
      "mfa_recovery_gateway_acknowledge:shape",
    );
    rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    await expect(releaseRecoveryCode(CODE_ID)).rejects.toThrow(
      "mfa_recovery_gateway_release:42501",
    );
  });
});

describe("portero de los códigos de respaldo: estado y revocar", () => {
  it("el estado entrega el juego vigente, o `{ total: 0 }` sin juego", async () => {
    rpc.mockResolvedValue({
      data: {
        total: 10,
        acknowledged: true,
        set_id: SET_ID,
        created_at: "2026-11-16T15:00:00.123+00:00",
      },
      error: null,
    });
    expect(await getRecoveryCodesStatus(USER_ID)).toEqual({
      total: 10,
      acknowledged: true,
      setId: SET_ID,
      createdAt: "2026-11-16T15:00:00.123+00:00",
    });
    expect(rpc).toHaveBeenCalledWith("mfa_recovery_codes_status", { p_user_id: USER_ID });
    rpc.mockResolvedValue({ data: { total: 0 }, error: null });
    expect(await getRecoveryCodesStatus(USER_ID)).toEqual({ total: 0 });
  });

  it("un estado con otra forma es un error de forma", async () => {
    for (const data of [
      null,
      {},
      { total: 3 },
      { total: 3, acknowledged: "si", set_id: SET_ID, created_at: "x" },
      { total: 3, acknowledged: true, set_id: "no-uuid", created_at: "x" },
      { total: -1 },
    ]) {
      rpc.mockResolvedValue({ data, error: null });
      await expect(getRecoveryCodesStatus(USER_ID)).rejects.toThrow(
        "mfa_recovery_gateway_status:shape",
      );
    }
    rpc.mockResolvedValue({ data: null, error: { code: "CP422" } });
    await expect(getRecoveryCodesStatus(USER_ID)).rejects.toThrow(
      "mfa_recovery_gateway_status:CP422",
    );
  });

  it("revocar entrega cuántos códigos se borraron; algo que no es un entero no negativo es un error de forma", async () => {
    rpc.mockResolvedValue({ data: 10, error: null });
    expect(await revokeRecoveryCodes(USER_ID)).toBe(10);
    expect(rpc).toHaveBeenCalledWith("mfa_recovery_codes_revoke", { p_user_id: USER_ID });
    rpc.mockResolvedValue({ data: 0, error: null });
    expect(await revokeRecoveryCodes(USER_ID)).toBe(0);
    for (const data of [null, "10", -1, 1.5]) {
      rpc.mockResolvedValue({ data, error: null });
      await expect(revokeRecoveryCodes(USER_ID)).rejects.toThrow(
        "mfa_recovery_gateway_revoke:shape",
      );
    }
  });
});
