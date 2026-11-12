import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const LINK_ID = "44444444-4444-4444-8444-444444444444";
const EMAIL = "duena@ejemplo.test";
const ORIGIN = "https://app.ejemplo.test";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE";
const REQUEST = { clientIp: "203.0.113.7", requestId: "r-1", userAgent: "Navegador/1.0" };

class FakeGatewayError extends Error {
  constructor(
    operation: string,
    readonly code: string,
  ) {
    super(`gateway:${operation}:${code}`);
  }
}
class FakeAdminError extends Error {
  override name = "MfaAdminGatewayError";
}
class FakeEmailConfigError extends Error {}

const consumeMfaAnnulQuota = vi.fn();
const claimAnnulLink = vi.fn();
const completeAnnulLink = vi.fn();
const releaseAnnulLink = vi.fn();
const revokeRemainingSessions = vi.fn();
const lockAccountAndRemoveFactors = vi.fn();
const sendWithRetry = vi.fn();
const getEmailTransport = vi.fn();
const loadEmailConfig = vi.fn();
const logAuditEvent = vi.fn();
const serverLog = vi.fn();
const sendRecovery = vi.fn();

vi.mock("./login-rate-limit", () => ({
  consumeMfaAnnulQuota: (...args: unknown[]) => consumeMfaAnnulQuota(...args),
}));
vi.mock("./mfa-alerts-gateway", () => ({
  MfaAlertsGatewayError: FakeGatewayError,
  claimAnnulLink: (...args: unknown[]) => claimAnnulLink(...args),
  completeAnnulLink: (...args: unknown[]) => completeAnnulLink(...args),
  releaseAnnulLink: (...args: unknown[]) => releaseAnnulLink(...args),
  revokeRemainingSessions: (...args: unknown[]) => revokeRemainingSessions(...args),
}));
vi.mock("./mfa-admin-gateway", () => ({
  lockAccountAndRemoveFactors: (...args: unknown[]) => lockAccountAndRemoveFactors(...args),
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
vi.mock("@/lib/log/server-log", () => ({ serverLog: (...args: unknown[]) => serverLog(...args) }));

const { annulSecondStep } = await import("./mfa-annul");
const { hashMfaAnnulToken } = await import("./mfa-annul-token");

beforeEach(() => {
  for (const mock of [
    consumeMfaAnnulQuota,
    claimAnnulLink,
    completeAnnulLink,
    releaseAnnulLink,
    revokeRemainingSessions,
    lockAccountAndRemoveFactors,
    sendWithRetry,
    getEmailTransport,
    loadEmailConfig,
    logAuditEvent,
    serverLog,
    sendRecovery,
  ]) {
    mock.mockReset();
  }
  consumeMfaAnnulQuota.mockResolvedValue(true);
  claimAnnulLink.mockResolvedValue({ linkId: LINK_ID, userId: USER_ID });
  lockAccountAndRemoveFactors.mockResolvedValue(undefined);
  revokeRemainingSessions.mockResolvedValue(0);
  completeAnnulLink.mockResolvedValue({ userId: USER_ID, email: EMAIL });
  releaseAnnulLink.mockResolvedValue(undefined);
  sendRecovery.mockResolvedValue(true);
  loadEmailConfig.mockReturnValue({ fromAddress: "cotizaciones@ejemplo.test" });
  getEmailTransport.mockReturnValue({ provider: "memory" });
  sendWithRetry.mockResolvedValue({ ok: true, providerMessageId: "m1" });
});

const everythingLogged = () =>
  JSON.stringify([...serverLog.mock.calls, ...logAuditEvent.mock.calls]);
const run = () => annulSecondStep(TOKEN, REQUEST, sendRecovery);

describe("annulSecondStep · antes de tocar la base", () => {
  it.each([
    ["vacío", ""],
    ["corto", "abc"],
    ["largo", `${TOKEN}x`],
    ["con un carácter que no es base64url", `${TOKEN.slice(0, 42)}!`],
    ["con un espacio", `${TOKEN.slice(0, 42)} `],
    ["con salto de línea", `${TOKEN.slice(0, 42)}\n`],
  ])("un código %s es «invalid» y NO consulta límites, base ni Supabase", async (_name, bad) => {
    expect(await annulSecondStep(bad, REQUEST, sendRecovery)).toEqual({ status: "invalid" });
    expect(consumeMfaAnnulQuota).not.toHaveBeenCalled();
    expect(claimAnnulLink).not.toHaveBeenCalled();
    expect(lockAccountAndRemoveFactors).not.toHaveBeenCalled();
    expect(sendRecovery).not.toHaveBeenCalled();
  });

  it("un valor que no es texto tampoco consulta nada", async () => {
    expect(await annulSecondStep(undefined as unknown as string, REQUEST, sendRecovery)).toEqual({
      status: "invalid",
    });
    expect(consumeMfaAnnulQuota).not.toHaveBeenCalled();
  });

  it("los límites cuentan por IP y por la HUELLA del código (nunca el código); pasados, no toma el enlace", async () => {
    consumeMfaAnnulQuota.mockResolvedValue(false);
    expect(await run()).toEqual({ status: "rate_limited" });
    expect(consumeMfaAnnulQuota).toHaveBeenCalledWith(REQUEST.clientIp, hashMfaAnnulToken(TOKEN));
    expect(JSON.stringify(consumeMfaAnnulQuota.mock.calls)).not.toContain(TOKEN);
    expect(claimAnnulLink).not.toHaveBeenCalled();
  });
});

describe("annulSecondStep · tomar el enlace", () => {
  it("toma el enlace con la huella; si no existe, venció, se usó o está tomado, el resultado es el MISMO `invalid` y no se toca la cuenta", async () => {
    claimAnnulLink.mockResolvedValue(null);
    expect(await run()).toEqual({ status: "invalid" });
    expect(claimAnnulLink).toHaveBeenCalledWith(hashMfaAnnulToken(TOKEN));
    expect(lockAccountAndRemoveFactors).not.toHaveBeenCalled();
    expect(completeAnnulLink).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("si la base falla al tomar el enlace, responde `failed` (no `invalid`) sin tocar la cuenta", async () => {
    claimAnnulLink.mockRejectedValue(new FakeGatewayError("annul_claim", "57014"));
    expect(await run()).toEqual({ status: "failed" });
    expect(lockAccountAndRemoveFactors).not.toHaveBeenCalled();
  });
});

describe("annulSecondStep · el orden de los pasos", () => {
  it("límites → tomar → dejar sin acceso → comprobar sesiones → completar → correo de recuperación → correo de aviso", async () => {
    expect(await run()).toEqual({ status: "annulled", recoveryEmailSent: true });
    const order = [
      consumeMfaAnnulQuota,
      claimAnnulLink,
      lockAccountAndRemoveFactors,
      revokeRemainingSessions,
      completeAnnulLink,
      sendRecovery,
      sendWithRetry,
    ].map((mock) => mock.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((position) => Number.isFinite(position))).toBe(true);
    expect(lockAccountAndRemoveFactors).toHaveBeenCalledWith(USER_ID);
    expect(revokeRemainingSessions).toHaveBeenCalledWith(USER_ID);
    expect(completeAnnulLink).toHaveBeenCalledWith(LINK_ID, {
      "x-cp-client-ip": "203.0.113.7",
      "x-cp-request-id": "r-1",
      "user-agent": "Navegador/1.0",
    });
    expect(releaseAnnulLink).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("los DOS correos van al correo de la cuenta (el que entregó la base) y el de aviso lleva la dirección pública de recuperar, sin código", async () => {
    await run();
    expect(sendRecovery).toHaveBeenCalledWith(EMAIL);
    const message = sendWithRetry.mock.calls[0][1];
    expect(message.to).toBe(EMAIL);
    expect(message.subject).toBe("Anulamos la verificación en dos pasos de tu cuenta");
    expect(message.html).toContain(`href="${ORIGIN}/recuperar-contrasena"`);
    expect(message.text).not.toContain(TOKEN);
    expect(sendWithRetry.mock.calls[0][2].deadlineMs - Date.now()).toBeLessThanOrEqual(15_000);
  });

  it("repetir la anulación sobre una cuenta ya anulada es seguro: el segundo enlace es `invalid`", async () => {
    expect(await run()).toMatchObject({ status: "annulled" });
    claimAnnulLink.mockResolvedValue(null);
    expect(await run()).toEqual({ status: "invalid" });
  });
});

describe("annulSecondStep · si algo falla a medio camino", () => {
  it.each([
    [
      "no se puede inutilizar la contraseña o borrar los factores",
      () =>
        lockAccountAndRemoveFactors.mockRejectedValue(
          new FakeAdminError("mfa_admin_gateway_lock_password:500"),
        ),
      "mfa_admin_gateway_lock_password:500",
    ],
    [
      "quedan sesiones",
      () => revokeRemainingSessions.mockResolvedValue(2),
      "gateway_sessions_left",
    ],
    [
      "la base no puede cerrar las sesiones",
      () =>
        revokeRemainingSessions.mockRejectedValue(new FakeGatewayError("revoke_sessions", "57014")),
      "gateway_57014",
    ],
    [
      "la base no completa",
      () => completeAnnulLink.mockRejectedValue(new FakeGatewayError("annul_complete", "57014")),
      "gateway_57014",
    ],
    [
      "el enlace ya no estaba abierto al completar",
      () => completeAnnulLink.mockResolvedValue(null),
      "gateway_not_open",
    ],
  ])(
    "si %s: suelta el enlace, audita `session.mfa_annul_failed` con solo un código y responde `failed`",
    async (_name, arrange, reason) => {
      arrange();
      expect(await run()).toEqual({ status: "failed" });
      expect(releaseAnnulLink).toHaveBeenCalledWith(LINK_ID);
      expect(logAuditEvent).toHaveBeenCalledWith({
        action: "session.mfa_annul_failed",
        result: "failure",
        actorUserId: USER_ID,
        details: { reason, stage: "annul" },
      });
      // Nada de correos: la anulación no terminó.
      expect(sendRecovery).not.toHaveBeenCalled();
      expect(sendWithRetry).not.toHaveBeenCalled();
    },
  );

  it("si además falla soltar el enlace, igual responde `failed` y lo deja en el registro", async () => {
    revokeRemainingSessions.mockResolvedValue(1);
    releaseAnnulLink.mockRejectedValue(new FakeGatewayError("annul_release", "57014"));
    expect(await run()).toEqual({ status: "failed" });
    expect(serverLog).toHaveBeenCalledWith("error", "mfa_annul_release_failed", {
      code: "gateway_57014",
    });
    expect(logAuditEvent).toHaveBeenCalled();
  });
});

describe("annulSecondStep · los correos de después no cortan nada", () => {
  it("si el correo de recuperación no sale (Supabase lo rechaza o lanza), la anulación vale y el aviso igual sale", async () => {
    sendRecovery.mockResolvedValue(false);
    expect(await run()).toEqual({ status: "annulled", recoveryEmailSent: false });
    expect(sendWithRetry).toHaveBeenCalledTimes(1);
    sendRecovery.mockRejectedValue(new Error("red"));
    expect(await run()).toEqual({ status: "annulled", recoveryEmailSent: false });
    expect(sendWithRetry).toHaveBeenCalledTimes(2);
  });

  it("si el correo de aviso no sale (rechazado o error de configuración), igual queda anulada", async () => {
    sendWithRetry.mockResolvedValue({ ok: false, retryable: false, code: "provider_rejected" });
    expect(await run()).toEqual({ status: "annulled", recoveryEmailSent: true });
    expect(serverLog).toHaveBeenCalledWith("warn", "mfa_annulled_notice_failed", {
      code: "provider_rejected",
    });
    getEmailTransport.mockImplementation(() => {
      throw new FakeEmailConfigError("falta clave");
    });
    expect(await run()).toEqual({ status: "annulled", recoveryEmailSent: true });
    expect(serverLog).toHaveBeenCalledWith("warn", "mfa_annulled_notice_failed", {
      code: "email_config",
    });
  });

  it("una cuenta sin correo queda anulada, sin correos", async () => {
    completeAnnulLink.mockResolvedValue({ userId: USER_ID, email: null });
    expect(await run()).toEqual({ status: "annulled", recoveryEmailSent: false });
    expect(sendRecovery).not.toHaveBeenCalled();
    expect(sendWithRetry).not.toHaveBeenCalled();
  });
});

describe("annulSecondStep · lo que nunca se registra", () => {
  it("ni el código del enlace, ni su huella, ni el correo van a un registro o a la auditoría, salga bien o mal", async () => {
    await run();
    revokeRemainingSessions.mockResolvedValue(3);
    await run();
    sendRecovery.mockResolvedValue(false);
    revokeRemainingSessions.mockResolvedValue(0);
    sendWithRetry.mockResolvedValue({ ok: false, retryable: true, code: "timeout" });
    await run();
    const logged = everythingLogged();
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(hashMfaAnnulToken(TOKEN));
    expect(logged).not.toContain(EMAIL);
    expect(serverLog.mock.calls.length + logAuditEvent.mock.calls.length).toBeGreaterThan(2);
  });
});
