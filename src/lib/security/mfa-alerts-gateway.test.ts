import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin-client", () => ({ createAdminClient: () => ({ rpc }) }));

const {
  MfaAlertsGatewayError,
  grantEnrollmentPermit,
  reserveEnrollmentAlert,
  revertEnrollmentAlert,
  settleEnrollmentAlert,
} = await import("./mfa-alerts-gateway");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FACTOR_ID = "22222222-2222-4222-8222-222222222222";
const ALERT_ID = "33333333-3333-4333-8333-333333333333";
const LINK_ID = "55555555-5555-4555-8555-555555555555";
const HASH = "a".repeat(64);

beforeEach(() => rpc.mockReset());

describe("portero de los avisos de activación", () => {
  it("el permiso llama a mfa_alert_expect con la cuenta y el factor y devuelve si se concedió", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await grantEnrollmentPermit(USER_ID, FACTOR_ID)).toBe(true);
    expect(rpc).toHaveBeenCalledWith("mfa_alert_expect", {
      p_user_id: USER_ID,
      p_factor_id: FACTOR_ID,
    });
    rpc.mockResolvedValue({ data: false, error: null });
    expect(await grantEnrollmentPermit(USER_ID, FACTOR_ID)).toBe(false);
    rpc.mockResolvedValue({ data: null, error: { code: "57014" } });
    await expect(grantEnrollmentPermit(USER_ID, FACTOR_ID)).rejects.toThrow(
      "mfa_alerts_gateway_expect:57014",
    );
  });

  it("reservar entrega la forma validada; sin avisos, `reserved: false`; una respuesta rara es un error de forma", async () => {
    rpc.mockResolvedValue({
      data: {
        reserved: true,
        alert_id: ALERT_ID,
        link_id: LINK_ID,
        factor_id: FACTOR_ID,
        verified_at: "2026-11-12T20:05:00Z",
        email: "duena@ejemplo.test",
        expires_at: "2026-11-15T20:05:00Z",
      },
      error: null,
    });
    expect(await reserveEnrollmentAlert(USER_ID, HASH)).toEqual({
      reserved: true,
      alertId: ALERT_ID,
      linkId: LINK_ID,
      factorId: FACTOR_ID,
      verifiedAt: "2026-11-12T20:05:00Z",
      email: "duena@ejemplo.test",
      expiresAt: "2026-11-15T20:05:00Z",
    });
    expect(rpc).toHaveBeenCalledWith("mfa_alerts_reserve", {
      p_user_id: USER_ID,
      p_token_sha256: HASH,
    });
    rpc.mockResolvedValue({ data: { reserved: false }, error: null });
    expect(await reserveEnrollmentAlert(USER_ID, HASH)).toEqual({ reserved: false });
    rpc.mockResolvedValue({ data: { reserved: true, alert_id: "no-uuid" }, error: null });
    await expect(reserveEnrollmentAlert(USER_ID, HASH)).rejects.toThrow(
      "mfa_alerts_gateway_reserve:shape",
    );
    rpc.mockResolvedValue({ data: null, error: { code: "CP422" } });
    await expect(reserveEnrollmentAlert(USER_ID, HASH)).rejects.toBeInstanceOf(
      MfaAlertsGatewayError,
    );
  });

  it("cerrar un intento manda el id del proveedor o un código, nunca ambos", async () => {
    rpc.mockResolvedValue({ data: "sent", error: null });
    expect(
      await settleEnrollmentAlert({
        alertId: ALERT_ID,
        sent: { provider: "resend", providerMessageId: "m1" },
      }),
    ).toBe("sent");
    expect(rpc).toHaveBeenLastCalledWith("mfa_alert_settle", {
      p_alert_id: ALERT_ID,
      p_provider: "resend",
      p_provider_message_id: "m1",
      p_error_code: null,
    });
    rpc.mockResolvedValue({ data: "failed", error: null });
    expect(await settleEnrollmentAlert({ alertId: ALERT_ID, errorCode: "timeout" })).toBe("failed");
    expect(rpc).toHaveBeenLastCalledWith("mfa_alert_settle", {
      p_alert_id: ALERT_ID,
      p_provider: null,
      p_provider_message_id: null,
      p_error_code: "timeout",
    });
    rpc.mockResolvedValue({ data: "otra-cosa", error: null });
    await expect(settleEnrollmentAlert({ alertId: ALERT_ID })).rejects.toThrow("settle:shape");
  });

  it("cerrar un intento repite si la base falla por algo pasajero, pero no si la respuesta es definitiva (permiso)", async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: "fetch failed" } })
      .mockResolvedValueOnce({ data: "sent", error: null });
    expect(
      await settleEnrollmentAlert({
        alertId: ALERT_ID,
        sent: { provider: "resend", providerMessageId: "m1" },
      }),
    ).toBe("sent");
    expect(rpc).toHaveBeenCalledTimes(2);
    rpc.mockReset();
    rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    await expect(settleEnrollmentAlert({ alertId: ALERT_ID, errorCode: "x" })).rejects.toThrow(
      "settle:42501",
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("revertir devuelve closed, reverted, pending o none; otra cosa es un error de forma", async () => {
    for (const outcome of ["closed", "reverted", "pending", "none"] as const) {
      rpc.mockResolvedValue({ data: outcome, error: null });
      expect(await revertEnrollmentAlert(USER_ID, FACTOR_ID, "x")).toBe(outcome);
    }
    expect(rpc).toHaveBeenLastCalledWith("mfa_alert_revert", {
      p_user_id: USER_ID,
      p_factor_id: FACTOR_ID,
      p_error_code: "x",
      p_only_permit: false,
    });
    // Con `onlyPermit` (al fallar un código) la base no toca un aviso pendiente.
    await revertEnrollmentAlert(USER_ID, FACTOR_ID, "x", { onlyPermit: true });
    expect(rpc).toHaveBeenLastCalledWith("mfa_alert_revert", {
      p_user_id: USER_ID,
      p_factor_id: FACTOR_ID,
      p_error_code: "x",
      p_only_permit: true,
    });
    rpc.mockResolvedValue({ data: 3, error: null });
    await expect(revertEnrollmentAlert(USER_ID, FACTOR_ID, "x")).rejects.toThrow("revert:shape");
  });
});
