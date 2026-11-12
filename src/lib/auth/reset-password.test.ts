import { beforeEach, describe, expect, it, vi } from "vitest";

// Elegir la contraseña nueva (H-003) y su efecto sobre el bloqueo del código de dos pasos (H-004a, ronda 2): un cambio
// exitoso limpia los contadores del camino «password» de la cuenta, y solo uno exitoso.

const USER_ID = "11111111-1111-4111-8111-111111111111";
const updateUser = vi.fn();
const signOut = vi.fn();
const logAuditEvent = vi.fn();
const clearPasswordPathSecondStepCounters = vi.fn();
const clearRecoverySession = vi.fn();
const hasRecoverySession = vi.fn();
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
  getOptionalUser: async () => ({ id: USER_ID }),
  getSessionState: async () => ({ status: "complete" }),
  requireUser: async () => ({ id: USER_ID }),
  hasRecoverySession: () => hasRecoverySession(),
  clearRecoverySession: () => clearRecoverySession(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { updateUser, signOut } }),
}));
vi.mock("@/lib/auth/login-audit", () => ({ logTenantLogins: vi.fn() }));
vi.mock("@/lib/team/invitation-cookie", () => ({
  clearInvitationCode: async () => undefined,
  hasPendingInvitation: async () => false,
}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn() }));
vi.mock("@/lib/audit/log", () => ({ logAuditEvent: (event: unknown) => logAuditEvent(event) }));
vi.mock("@/lib/http/request-context", () => ({
  getAppOrigin: () => "http://localhost",
  getRequestContext: async () => ({ requestId: "r", clientIp: "203.0.113.7", userAgent: null }),
}));
vi.mock("@/lib/security/login-rate-limit", () => ({
  RATE_LIMITED_MESSAGE: "Demasiados intentos.",
  clearPasswordPathSecondStepCounters: (...args: unknown[]) =>
    clearPasswordPathSecondStepCounters(...args),
}));
vi.mock("@/lib/legal/documents", () => ({ legalDocuments: {} }));

const { resetPasswordAction } = await import("./actions");

const NEW_PASSWORD = "una-clave-larga-y-ficticia";
const form = (password: string) => {
  const data = new FormData();
  data.set("password", password);
  data.set("confirmPassword", password);
  return data;
};

beforeEach(() => {
  for (const mock of [
    updateUser,
    signOut,
    logAuditEvent,
    clearPasswordPathSecondStepCounters,
    clearRecoverySession,
    hasRecoverySession,
  ]) {
    mock.mockReset();
  }
  hasRecoverySession.mockResolvedValue(true);
  signOut.mockResolvedValue({ error: null });
});

describe("resetPasswordAction y el bloqueo del código de dos pasos", () => {
  it("un cambio exitoso limpia los contadores del camino «password» de ESA cuenta, y va al inicio", async () => {
    updateUser.mockResolvedValue({ error: null });
    await expect(resetPasswordAction({ status: "idle" }, form(NEW_PASSWORD))).rejects.toMatchObject(
      {
        to: "/",
      },
    );
    expect(clearPasswordPathSecondStepCounters).toHaveBeenCalledTimes(1);
    expect(clearPasswordPathSecondStepCounters).toHaveBeenCalledWith(USER_ID);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "session.password_changed", result: "success" }),
    );
  });

  it("si Supabase rechaza la contraseña nueva, NO se limpia nada", async () => {
    updateUser.mockResolvedValue({ error: { code: "weak_password", status: 422 } });
    const state = await resetPasswordAction({ status: "idle" }, form(NEW_PASSWORD));
    expect(state.status).toBe("error");
    expect(clearPasswordPathSecondStepCounters).not.toHaveBeenCalled();
  });

  it("una contraseña inválida para el formulario ni llega a Supabase ni limpia nada", async () => {
    const state = await resetPasswordAction({ status: "idle" }, form("corta"));
    expect(state.status).toBe("error");
    expect(updateUser).not.toHaveBeenCalled();
    expect(clearPasswordPathSecondStepCounters).not.toHaveBeenCalled();
  });

  it("sin la sesión del enlace del correo se rechaza antes de cambiar nada", async () => {
    hasRecoverySession.mockResolvedValue(false);
    await expect(
      resetPasswordAction({ status: "idle" }, form(NEW_PASSWORD)),
    ).rejects.toBeInstanceOf(Redirected);
    expect(updateUser).not.toHaveBeenCalled();
    expect(clearPasswordPathSecondStepCounters).not.toHaveBeenCalled();
  });
});
