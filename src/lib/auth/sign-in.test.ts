import { beforeEach, describe, expect, it, vi } from "vitest";

// Ingresar con contraseña (H-002) y la verificación en dos pasos (H-004a): con un factor verificado la contraseña no
// basta; se va a escribir el código y el ingreso de cada organización se escribe después.

const signInWithPassword = vi.fn();
const logAuditEvent = vi.fn();
const logTenantLogins = vi.fn();
const hasPendingInvitation = vi.fn();
const deliverPendingEnrollmentNotices = vi.fn();
class Redirected extends Error {
  constructor(readonly to: string) {
    super(to);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], delete: () => {} }) }));
vi.mock("@/lib/auth/session", () => ({
  getOptionalUser: async () => null,
  getSessionState: async () => ({ status: "signed_out" }),
  requireUser: async () => ({ id: "u" }),
  hasRecoverySession: async () => false,
  clearRecoverySession: async () => undefined,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signInWithPassword } }),
}));
vi.mock("@/lib/auth/login-audit", () => ({
  logTenantLogins: (...args: unknown[]) => logTenantLogins(...args),
}));
vi.mock("@/lib/team/invitation-cookie", () => ({
  clearInvitationCode: async () => undefined,
  hasPendingInvitation: () => hasPendingInvitation(),
}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn() }));
vi.mock("@/lib/audit/log", () => ({ logAuditEvent: (event: unknown) => logAuditEvent(event) }));
vi.mock("@/lib/http/request-context", () => ({
  getAppOrigin: () => "http://localhost",
  getRequestContext: async () => ({ requestId: "r", clientIp: "203.0.113.7", userAgent: null }),
}));
vi.mock("@/lib/security/login-rate-limit", () => ({
  RATE_LIMITED_MESSAGE: "Demasiados intentos.",
  emailFingerprint: () => "huella",
  isLoginLocked: async () => false,
  recordLoginFailure: async () => false,
  clearLoginFailures: async () => undefined,
}));
vi.mock("@/lib/security/mfa-enrollment-notice", () => ({
  deliverPendingEnrollmentNotices: (...args: unknown[]) => deliverPendingEnrollmentNotices(...args),
}));
vi.mock("@/lib/legal/documents", () => ({ legalDocuments: {} }));

const { signInAction } = await import("./actions");

const CREDENTIALS = (() => {
  const data = new FormData();
  data.set("email", "ana@ejemplo.test");
  data.set("password", "contrasena-ficticia-123");
  return data;
})();

async function redirectOf(): Promise<string> {
  try {
    await signInAction({ status: "idle" }, CREDENTIALS);
  } catch (error) {
    if (error instanceof Redirected) return error.to;
    throw error;
  }
  throw new Error("se esperaba una redirección");
}

beforeEach(() => {
  signInWithPassword.mockReset();
  logAuditEvent.mockReset();
  logTenantLogins.mockReset();
  hasPendingInvitation.mockReset().mockResolvedValue(false);
  deliverPendingEnrollmentNotices
    .mockReset()
    .mockResolvedValue({ sentFactorIds: [], sentTo: null, failures: [] });
});

describe("signInAction y la verificación en dos pasos", () => {
  it("con un factor verificado va a escribir el código y NO escribe el ingreso por organización", async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: { id: "u1", factors: [{ id: "f", status: "verified", factor_type: "totp" }] } },
      error: null,
    });
    expect(await redirectOf()).toBe("/ingresar/codigo");
    expect(logTenantLogins).not.toHaveBeenCalled();
    // El ingreso de la plataforma sí queda, marcado como «solo contraseña, falta el código».
    expect(logAuditEvent).toHaveBeenCalledWith({
      action: "session.login",
      result: "success",
      actorUserId: "u1",
      details: { stage: "password", secondStepPending: true },
    });
  });

  it("con un factor verificado reintenta los avisos de activación pendientes de ESA cuenta (la dueña bloqueada) ANTES de ir al código; sin factor no los toca", async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: { id: "u1", factors: [{ id: "f", status: "verified", factor_type: "totp" }] } },
      error: null,
    });
    await redirectOf();
    expect(deliverPendingEnrollmentNotices).toHaveBeenCalledTimes(1);
    // Solo recibe la cuenta que acaba de entrar: el correo lo decide la base, nunca la petición.
    expect(deliverPendingEnrollmentNotices).toHaveBeenCalledWith("u1");
    deliverPendingEnrollmentNotices.mockClear();
    signInWithPassword.mockResolvedValue({
      data: { user: { id: "u1", factors: [] } },
      error: null,
    });
    await redirectOf();
    expect(deliverPendingEnrollmentNotices).not.toHaveBeenCalled();
  });

  it("con un factor a medias (sin verificar) o sin factores entra como siempre", async () => {
    for (const factors of [
      undefined,
      [],
      [{ id: "f", status: "unverified", factor_type: "totp" }],
    ]) {
      logTenantLogins.mockClear();
      signInWithPassword.mockResolvedValue({ data: { user: { id: "u1", factors } }, error: null });
      expect(await redirectOf()).toBe("/");
      expect(logTenantLogins).toHaveBeenCalledTimes(1);
      // Sin la verificación activa el registro es el de siempre: sin detalles.
      expect(logAuditEvent).toHaveBeenLastCalledWith({
        action: "session.login",
        result: "success",
        actorUserId: "u1",
      });
      logAuditEvent.mockClear();
    }
  });

  it("con una invitación esperando y sin factor, sigue yendo a la invitación", async () => {
    hasPendingInvitation.mockResolvedValue(true);
    signInWithPassword.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    expect(await redirectOf()).toBe("/invitacion");
  });
});
