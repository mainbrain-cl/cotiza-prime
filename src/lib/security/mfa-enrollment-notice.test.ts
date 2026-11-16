import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ALERT_ID = "33333333-3333-4333-8333-333333333333";
const LINK_ID = "55555555-5555-4555-8555-555555555555";
const FACTOR_ID = "22222222-2222-4222-8222-222222222222";
const EMAIL = "duena@ejemplo.test";
const ORIGIN = "https://app.ejemplo.test";

class FakeGatewayError extends Error {
  constructor(readonly code: string) {
    super(`gateway:${code}`);
  }
}
class FakeEmailConfigError extends Error {}

const reserveEnrollmentAlert = vi.fn();
const settleEnrollmentAlert = vi.fn();
const revertEnrollmentAlert = vi.fn();
const deleteMfaFactor = vi.fn();
const sendWithRetry = vi.fn();
const getEmailTransport = vi.fn();
const loadEmailConfig = vi.fn();
const logAuditEvent = vi.fn();
const serverLog = vi.fn();

vi.mock("./mfa-alerts-gateway", () => ({
  MfaAlertsGatewayError: FakeGatewayError,
  reserveEnrollmentAlert: (...args: unknown[]) => reserveEnrollmentAlert(...args),
  settleEnrollmentAlert: (...args: unknown[]) => settleEnrollmentAlert(...args),
  revertEnrollmentAlert: (...args: unknown[]) => revertEnrollmentAlert(...args),
}));
vi.mock("./mfa-admin-gateway", () => ({
  deleteMfaFactor: (...args: unknown[]) => deleteMfaFactor(...args),
}));
vi.mock("@/lib/quotes/send/dispatch", () => ({
  sendWithRetry: (...args: unknown[]) => sendWithRetry(...args),
}));
vi.mock("@/lib/email/transport", () => ({
  EmailConfigError: FakeEmailConfigError,
  getEmailTransport: (...args: unknown[]) => getEmailTransport(...args),
}));
vi.mock("@/lib/email/config", () => ({ loadEmailConfig: () => loadEmailConfig() }));
vi.mock("@/lib/http/request-context", () => ({ getAppOrigin: () => ORIGIN }));
vi.mock("@/lib/audit/log", () => ({ logAuditEvent: (e: unknown) => logAuditEvent(e) }));
vi.mock("@/lib/log/server-log", () => ({
  serverLog: (...args: unknown[]) => serverLog(...args),
}));

const { deliverPendingEnrollmentNotices, failureCodeFor, revertEnrollment } =
  await import("./mfa-enrollment-notice");
const { hashMfaAnnulToken } = await import("./mfa-annul-token");

const RESERVED = {
  reserved: true as const,
  alertId: ALERT_ID,
  linkId: LINK_ID,
  factorId: FACTOR_ID,
  verifiedAt: "2026-11-12T20:05:00Z",
  email: EMAIL,
  expiresAt: "2026-11-15T20:05:00Z",
};

beforeEach(() => {
  for (const mock of [
    reserveEnrollmentAlert,
    settleEnrollmentAlert,
    revertEnrollmentAlert,
    deleteMfaFactor,
    sendWithRetry,
    getEmailTransport,
    loadEmailConfig,
    logAuditEvent,
    serverLog,
  ]) {
    mock.mockReset();
  }
  loadEmailConfig.mockReturnValue({ fromAddress: "cotizaciones@ejemplo.test" });
  getEmailTransport.mockReturnValue({ provider: "memory" });
  sendWithRetry.mockResolvedValue({ ok: true, providerMessageId: "msg-1" });
  settleEnrollmentAlert.mockResolvedValue("sent");
  revertEnrollmentAlert.mockResolvedValue("reverted");
  deleteMfaFactor.mockResolvedValue(undefined);
  // Un aviso pendiente y luego nada.
  reserveEnrollmentAlert.mockResolvedValueOnce(RESERVED).mockResolvedValue({ reserved: false });
});

const everythingLogged = () =>
  JSON.stringify([...serverLog.mock.calls, ...logAuditEvent.mock.calls]);

describe("deliverPendingEnrollmentNotices", () => {
  it("sin avisos pendientes no envía nada", async () => {
    reserveEnrollmentAlert.mockReset();
    reserveEnrollmentAlert.mockResolvedValue({ reserved: false });
    const delivery = await deliverPendingEnrollmentNotices(USER_ID);
    expect(delivery).toEqual({ sentFactorIds: [], sentTo: null, failures: [] });
    expect(sendWithRetry).not.toHaveBeenCalled();
  });

  it("envía al correo que la BASE entregó (no a otro), con el enlace de APP_ORIGIN y el código tras el «#»; la base recibió la huella de ESE código", async () => {
    const delivery = await deliverPendingEnrollmentNotices(USER_ID);
    expect(delivery).toEqual({ sentFactorIds: [FACTOR_ID], sentTo: EMAIL, failures: [] });

    const [, tokenSha256] = reserveEnrollmentAlert.mock.calls[0];
    expect(reserveEnrollmentAlert.mock.calls[0][0]).toBe(USER_ID);
    expect(tokenSha256).toMatch(/^[0-9a-f]{64}$/);

    const message = sendWithRetry.mock.calls[0][1];
    expect(message.to).toBe(EMAIL);
    // La clave anti-duplicado es el id del ENLACE (uno por correo): ni el aviso, ni la huella, ni el código.
    expect(message.idempotencyKey).toBe(LINK_ID);
    expect(message.idempotencyKey).not.toBe(ALERT_ID);
    expect(message.idempotencyKey).not.toBe(tokenSha256);
    const token = new RegExp(`${ORIGIN}/cuenta/anular-dos-pasos#([A-Za-z0-9_-]{43})`).exec(
      message.text,
    )?.[1];
    expect(token, "el correo trae el enlace con el código").toBeTruthy();
    // El código que viaja en el correo es el de la huella que se guardó, y la huella no está en el correo.
    expect(hashMfaAnnulToken(token!)).toBe(tokenSha256);
    expect(message.text).not.toContain(tokenSha256);
    expect(message.html).toContain(`href="${ORIGIN}/cuenta/anular-dos-pasos#${token}"`);
    // El plazo de envío es de unos 15 s.
    const { deadlineMs } = sendWithRetry.mock.calls[0][2];
    expect(deadlineMs - Date.now()).toBeLessThanOrEqual(15_000);

    expect(settleEnrollmentAlert).toHaveBeenCalledWith({
      alertId: ALERT_ID,
      sent: { provider: "memory", providerMessageId: "msg-1" },
    });
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.mfa_notice_sent",
        result: "success",
        actorUserId: USER_ID,
      }),
    );
  });

  it("jamás deja el código, su huella ni el correo en un registro o en la auditoría, salgan bien o mal los avisos", async () => {
    sendWithRetry.mockResolvedValueOnce({ ok: false, retryable: false, code: "provider_rejected" });
    reserveEnrollmentAlert.mockReset();
    reserveEnrollmentAlert
      .mockResolvedValueOnce(RESERVED)
      .mockResolvedValueOnce(RESERVED)
      .mockResolvedValue({ reserved: false });
    await deliverPendingEnrollmentNotices(USER_ID);
    const hashes = reserveEnrollmentAlert.mock.calls.map(([, hash]) => hash as string);
    const logged = everythingLogged();
    expect(logged).not.toContain(EMAIL);
    for (const hash of hashes) expect(logged).not.toContain(hash);
    for (const [, message] of sendWithRetry.mock.calls) {
      const token = /#([A-Za-z0-9_-]{43})/.exec(message.text)![1];
      expect(logged).not.toContain(token);
    }
  });

  it.each([
    [
      "el proveedor rechaza el correo",
      { ok: false, retryable: false, code: "provider_rejected" },
      "provider_rejected",
    ],
    [
      "el destinatario no está permitido",
      { ok: false, retryable: false, code: "recipient_not_allowed" },
      "recipient_not_allowed",
    ],
    [
      "el proveedor no responde a tiempo",
      { ok: false, retryable: true, code: "timeout" },
      "timeout",
    ],
  ])(
    "si %s, el fallo queda con su código, el intento se anota fallido y no se audita como enviado",
    async (_name, result, code) => {
      sendWithRetry.mockResolvedValue(result);
      const delivery = await deliverPendingEnrollmentNotices(USER_ID);
      expect(delivery.sentFactorIds).toEqual([]);
      expect(delivery.failures).toEqual([{ alertId: ALERT_ID, factorId: FACTOR_ID, code }]);
      expect(settleEnrollmentAlert).toHaveBeenCalledWith({ alertId: ALERT_ID, errorCode: code });
      expect(logAuditEvent).not.toHaveBeenCalled();
      expect(serverLog).toHaveBeenCalledWith("warn", "mfa_notice_failed", { stage: "send", code });
    },
  );

  it("un error de configuración del correo (o de APP_ORIGIN) es un fallo con código, no una excepción", async () => {
    getEmailTransport.mockImplementation(() => {
      throw new FakeEmailConfigError("falta RESEND_API_KEY");
    });
    const delivery = await deliverPendingEnrollmentNotices(USER_ID);
    expect(delivery.failures).toEqual([
      { alertId: ALERT_ID, factorId: FACTOR_ID, code: "email_config" },
    ]);
    expect(everythingLogged()).not.toContain("RESEND");
    loadEmailConfig.mockImplementation(() => {
      throw new Error("inesperado");
    });
    reserveEnrollmentAlert.mockResolvedValueOnce(RESERVED).mockResolvedValue({ reserved: false });
    const second = await deliverPendingEnrollmentNotices(USER_ID);
    expect(second.failures[0].code).toBe("unexpected");
  });

  it("una cuenta sin correo es un fallo `no_recipient` (no se manda nada)", async () => {
    reserveEnrollmentAlert.mockReset();
    reserveEnrollmentAlert
      .mockResolvedValueOnce({ ...RESERVED, email: null, expiresAt: null })
      .mockResolvedValue({ reserved: false });
    const delivery = await deliverPendingEnrollmentNotices(USER_ID);
    expect(delivery.failures).toEqual([
      { alertId: ALERT_ID, factorId: FACTOR_ID, code: "no_recipient" },
    ]);
    expect(sendWithRetry).not.toHaveBeenCalled();
  });

  it("si la base no responde al reservar, devuelve el fallo sin lanzar y deja de intentar", async () => {
    reserveEnrollmentAlert.mockReset();
    reserveEnrollmentAlert.mockRejectedValue(new FakeGatewayError("57014"));
    const delivery = await deliverPendingEnrollmentNotices(USER_ID);
    expect(delivery.failures).toEqual([{ alertId: null, factorId: null, code: "gateway_57014" }]);
    expect(reserveEnrollmentAlert).toHaveBeenCalledTimes(1);
  });

  it("si el correo salió pero no se pudo anotar, la persona fue avisada (cuenta como enviado) pero el aviso QUEDA `pending` en la base; el enlace ya sirve (la toma acepta `pending`) y se reintentará en el próximo ingreso", async () => {
    settleEnrollmentAlert.mockRejectedValue(new FakeGatewayError("57014"));
    const delivery = await deliverPendingEnrollmentNotices(USER_ID);
    expect(delivery.sentFactorIds).toEqual([FACTOR_ID]);
    expect(delivery.failures).toEqual([]);
    expect(serverLog).toHaveBeenCalledWith("warn", "mfa_notice_settle_failed", {
      code: "gateway_57014",
    });
    // Nada la revierte: no hay reversión ni se borra el factor, y el correo salió una sola vez.
    expect(revertEnrollmentAlert).not.toHaveBeenCalled();
    expect(deleteMfaFactor).not.toHaveBeenCalled();
    expect(sendWithRetry).toHaveBeenCalledTimes(1);
  });

  it("dos reintentos del mismo aviso llevan códigos nuevos y claves anti-duplicado DISTINTAS (una por enlace)", async () => {
    reserveEnrollmentAlert.mockReset();
    reserveEnrollmentAlert
      .mockResolvedValueOnce(RESERVED)
      .mockResolvedValueOnce({ ...RESERVED, linkId: "66666666-6666-4666-8666-666666666666" })
      .mockResolvedValue({ reserved: false });
    await deliverPendingEnrollmentNotices(USER_ID);
    const keys = sendWithRetry.mock.calls.map(([, message]) => message.idempotencyKey);
    expect(keys).toEqual([LINK_ID, "66666666-6666-4666-8666-666666666666"]);
  });

  it("atiende hasta 3 avisos de la cuenta por llamada, con un código nuevo cada uno", async () => {
    reserveEnrollmentAlert.mockReset();
    reserveEnrollmentAlert.mockResolvedValue(RESERVED);
    const delivery = await deliverPendingEnrollmentNotices(USER_ID);
    expect(reserveEnrollmentAlert).toHaveBeenCalledTimes(3);
    expect(delivery.sentFactorIds).toHaveLength(3);
    const hashes = new Set(reserveEnrollmentAlert.mock.calls.map(([, hash]) => hash));
    expect(hashes.size).toBe(3);
  });
});

describe("failureCodeFor", () => {
  it("da el código del fallo de ESE factor; si no hay, el primero; si no hay ninguno, `not_sent`", () => {
    const failures = [
      { alertId: "a", factorId: "otro", code: "timeout" },
      { alertId: "b", factorId: FACTOR_ID, code: "provider_rejected" },
    ];
    expect(failureCodeFor({ sentFactorIds: [], sentTo: null, failures }, FACTOR_ID)).toBe(
      "provider_rejected",
    );
    expect(failureCodeFor({ sentFactorIds: [], sentTo: null, failures }, "x")).toBe("timeout");
    expect(failureCodeFor({ sentFactorIds: [], sentTo: null, failures: [] }, FACTOR_ID)).toBe(
      "not_sent",
    );
  });
});

describe("revertEnrollment", () => {
  it("borra el factor ANTES de anotar la reversión, y deja la auditoría con solo el motivo", async () => {
    expect(await revertEnrollment(USER_ID, FACTOR_ID, "provider_rejected")).toBe(true);
    expect(deleteMfaFactor).toHaveBeenCalledWith(USER_ID, FACTOR_ID);
    expect(revertEnrollmentAlert).toHaveBeenCalledWith(USER_ID, FACTOR_ID, "provider_rejected");
    expect(deleteMfaFactor.mock.invocationCallOrder[0]).toBeLessThan(
      revertEnrollmentAlert.mock.invocationCallOrder[0],
    );
    expect(logAuditEvent).toHaveBeenCalledWith({
      action: "session.mfa_enroll_reverted",
      result: "failure",
      actorUserId: USER_ID,
      details: { reason: "provider_rejected", stage: "enrollment", factorType: "totp" },
    });
  });

  it("si no se pudo borrar el factor, NO anota la reversión ni la audita (el aviso sigue pendiente para reintentarse) y devuelve false", async () => {
    deleteMfaFactor.mockRejectedValue(new Error("mfa_admin_gateway_delete_factor:500"));
    expect(await revertEnrollment(USER_ID, FACTOR_ID, "timeout")).toBe(false);
    expect(revertEnrollmentAlert).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(serverLog).toHaveBeenCalledWith("error", "mfa_revert_failed", {
      code: "mfa_admin_gateway_delete_factor:500",
    });
  });

  it("si el factor se borró pero no se pudo anotar, igual cuenta como revertida (el aviso se cierra solo al ver que el factor ya no está)", async () => {
    revertEnrollmentAlert.mockRejectedValue(new FakeGatewayError("57014"));
    expect(await revertEnrollment(USER_ID, FACTOR_ID, "timeout")).toBe(true);
    expect(logAuditEvent).toHaveBeenCalled();
  });
});
