import { beforeEach, describe, expect, it, vi } from "vitest";

// «Acepta la nueva versión» (H-110): quien venía de abrir una invitación vuelve a ella; los demás, al inicio.

const rpc = vi.fn();
const hasPending = vi.fn();
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
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async () => ({ id: "u", email: "x@ejemplo.test", emailVerified: true }),
  getOptionalUser: async () => null,
  hasRecoverySession: async () => false,
  clearRecoverySession: async () => undefined,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));
vi.mock("@/lib/http/request-context", () => ({
  getAppOrigin: () => "http://localhost",
  getRequestContext: async () => ({ requestId: "r", clientIp: null, userAgent: null }),
}));
vi.mock("@/lib/team/invitation-cookie", () => ({
  hasPendingInvitation: () => hasPending(),
}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn() }));
vi.mock("@/lib/audit/log", () => ({ logAuditEvent: vi.fn() }));
vi.mock("@/lib/security/login-rate-limit", () => ({}));
vi.mock("@/lib/legal/documents", () => ({ legalDocuments: {} }));

const { acceptLegalAction } = await import("./actions");

async function redirectOf(): Promise<string> {
  try {
    await acceptLegalAction();
  } catch (error) {
    if (error instanceof Redirected) return error.to;
    throw error;
  }
  throw new Error("se esperaba una redirección");
}

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ error: null });
  hasPending.mockReset();
});

describe("acceptLegalAction", () => {
  it("con una invitación esperando en este navegador, vuelve a ella", async () => {
    hasPending.mockResolvedValue(true);
    expect(await redirectOf()).toBe("/invitacion");
  });

  it("sin invitación, va al inicio", async () => {
    hasPending.mockResolvedValue(false);
    expect(await redirectOf()).toBe("/");
  });

  it("si no se pudo registrar la aceptación, vuelve a la pantalla de términos con el error (y no a la invitación)", async () => {
    hasPending.mockResolvedValue(true);
    rpc.mockResolvedValue({ error: { code: "XX000" } });
    expect(await redirectOf()).toBe("/aceptar-terminos?error=1");
  });
});
