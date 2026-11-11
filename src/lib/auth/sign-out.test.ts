import { beforeEach, describe, expect, it, vi } from "vitest";

// Cerrar sesión (H-002) y la invitación guardada en el navegador (H-009): el cierre normal la borra (en un
// computador compartido, quien ingrese después no cae en la invitación de otra persona); solo el botón «Cerrar
// sesión e ingresar con otro correo» de la propia invitación la conserva.

const signOut = vi.fn();
const clearInvitation = vi.fn(async () => undefined);
const deleted: string[] = [];
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
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [{ name: "sb-local-auth-token" }, { name: "otra" }],
    delete: (name: string) => deleted.push(name),
  }),
}));
const sessionState = vi.fn();
const USER = { id: "u", email: "x@ejemplo.test", emailVerified: true };
const audit = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getOptionalUser: async () => USER,
  getSessionState: () => sessionState(),
  requireUser: async () => ({ id: "u" }),
  hasRecoverySession: async () => false,
  clearRecoverySession: async () => undefined,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signOut } }) }));
vi.mock("@/lib/team/invitation-cookie", () => ({
  clearInvitationCode: () => clearInvitation(),
  hasPendingInvitation: async () => true,
}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn() }));
vi.mock("@/lib/audit/log", () => ({ logAuditEvent: (event: unknown) => audit(event) }));
vi.mock("@/lib/http/request-context", () => ({
  getAppOrigin: () => "http://localhost",
  getRequestContext: async () => ({ requestId: "r", clientIp: null, userAgent: null }),
}));
vi.mock("@/lib/security/login-rate-limit", () => ({}));
vi.mock("@/lib/legal/documents", () => ({ legalDocuments: {} }));

const { signOutAction, signOutKeepingInvitationAction } = await import("./actions");

async function redirectOf(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Redirected) return error.to;
    throw error;
  }
  throw new Error("se esperaba una redirección");
}

beforeEach(() => {
  signOut.mockReset().mockResolvedValue({ error: null });
  clearInvitation.mockClear();
  deleted.length = 0;
  audit.mockReset();
  sessionState.mockReset().mockResolvedValue({
    status: "complete",
    user: USER,
    secondStep: { active: false, since: null },
  });
});

describe("cierre de sesión normal", () => {
  it("borra la invitación guardada en este navegador", async () => {
    expect(await redirectOf(signOutAction)).toBe("/ingresar?aviso=sesion-cerrada");
    expect(clearInvitation).toHaveBeenCalledTimes(1);
  });

  it("también la borra si el servidor de autenticación no responde", async () => {
    signOut.mockResolvedValue({ error: { code: "x", status: 500 } });
    expect(await redirectOf(signOutAction)).toBe("/ingresar?aviso=cierre-incompleto");
    expect(clearInvitation).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual(["sb-local-auth-token"]);
  });
});

describe("«Cerrar sesión e ingresar con otro correo»", () => {
  it("cierra la sesión pero conserva la invitación para seguir con la cuenta correcta", async () => {
    expect(await redirectOf(signOutKeepingInvitationAction)).toBe("/ingresar?aviso=sesion-cerrada");
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(clearInvitation).not.toHaveBeenCalled();
  });
});

describe("cierre de sesión y verificación en dos pasos (H-004a)", () => {
  it("una sesión parcial (falta el código) también cierra y queda en la auditoría con su autor", async () => {
    sessionState.mockResolvedValue({ status: "second_step_pending", user: USER });
    expect(await redirectOf(signOutAction)).toBe("/ingresar?aviso=sesion-cerrada");
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "session.logout", actorUserId: USER.id }),
    );
  });

  it("sin sesión cierra igual y no escribe auditoría", async () => {
    sessionState.mockResolvedValue({ status: "signed_out" });
    expect(await redirectOf(signOutAction)).toBe("/ingresar?aviso=sesion-cerrada");
    expect(audit).not.toHaveBeenCalled();
  });
});
