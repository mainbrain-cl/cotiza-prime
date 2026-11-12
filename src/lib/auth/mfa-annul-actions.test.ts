import { beforeEach, describe, expect, it, vi } from "vitest";

const annulSecondStep = vi.fn();
const resetPasswordForEmail = vi.fn();
const serverLog = vi.fn();

vi.mock("@/lib/security/mfa-annul", () => ({
  annulSecondStep: (...args: unknown[]) => annulSecondStep(...args),
}));
vi.mock("@/lib/http/request-context", () => ({
  getRequestContext: async () => ({ requestId: "r-1", clientIp: "203.0.113.7", userAgent: "UA" }),
  getAppOrigin: () => "https://app.ejemplo.test",
}));
vi.mock("@/lib/security/login-rate-limit", () => ({
  RATE_LIMITED_MESSAGE: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { resetPasswordForEmail } }),
}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: (...args: unknown[]) => serverLog(...args) }));

const { annulSecondStepAction } = await import("./mfa-annul-actions");
const {
  MFA_ANNUL_DONE_MESSAGE,
  MFA_ANNUL_DONE_NO_EMAIL_MESSAGE,
  MFA_ANNUL_FAILED_MESSAGE,
  MFA_ANNUL_INVALID_MESSAGE,
} = await import("./mfa-annul-messages");

const IDLE = { status: "idle" } as const;
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

beforeEach(() => {
  annulSecondStep.mockReset();
  resetPasswordForEmail.mockReset().mockResolvedValue({ error: null });
  serverLog.mockReset();
});

describe("annulSecondStepAction", () => {
  it("pasa el código del campo oculto, el origen de la petición y nada más al servicio", async () => {
    annulSecondStep.mockResolvedValue({ status: "invalid" });
    await annulSecondStepAction(IDLE, form({ token: "el-codigo", correo: "otra@ejemplo.test" }));
    expect(annulSecondStep).toHaveBeenCalledTimes(1);
    expect(annulSecondStep.mock.calls[0][0]).toBe("el-codigo");
    expect(annulSecondStep.mock.calls[0][1]).toEqual({
      clientIp: "203.0.113.7",
      requestId: "r-1",
      userAgent: "UA",
    });
    // Sin campo, o con algo que no es texto, el código es vacío.
    annulSecondStep.mockClear();
    const data = new FormData();
    data.set("token", new Blob(["x"]));
    await annulSecondStepAction(IDLE, data);
    await annulSecondStepAction(IDLE, new FormData());
    expect(annulSecondStep.mock.calls.map(([token]) => token)).toEqual(["", ""]);
  });

  it("los cuatro resultados se traducen a su mensaje; el enlace que no sirve (de cualquier forma) da UN solo mensaje", async () => {
    annulSecondStep.mockResolvedValueOnce({ status: "annulled", recoveryEmailSent: true });
    expect(await annulSecondStepAction(IDLE, form({ token: "x" }))).toEqual({
      status: "saved",
      message: MFA_ANNUL_DONE_MESSAGE,
    });
    annulSecondStep.mockResolvedValueOnce({ status: "annulled", recoveryEmailSent: false });
    expect(await annulSecondStepAction(IDLE, form({ token: "x" }))).toEqual({
      status: "saved",
      message: MFA_ANNUL_DONE_NO_EMAIL_MESSAGE,
    });
    annulSecondStep.mockResolvedValueOnce({ status: "rate_limited" });
    expect(await annulSecondStepAction(IDLE, form({ token: "x" }))).toEqual({
      status: "error",
      message: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
    });
    annulSecondStep.mockResolvedValueOnce({ status: "failed" });
    expect(await annulSecondStepAction(IDLE, form({ token: "x" }))).toEqual({
      status: "error",
      message: MFA_ANNUL_FAILED_MESSAGE,
    });
    annulSecondStep.mockResolvedValueOnce({ status: "invalid" });
    expect(await annulSecondStepAction(IDLE, form({ token: "x" }))).toEqual({
      status: "error",
      message: MFA_ANNUL_INVALID_MESSAGE,
    });
    expect(MFA_ANNUL_INVALID_MESSAGE).toBe(
      "Este enlace ya no sirve. Si alguien activó la verificación en tu cuenta sin tu permiso, escríbenos.",
    );
    expect(MFA_ANNUL_DONE_MESSAGE).toBe(
      "Anulamos la activación y cerramos todas las sesiones. Te enviamos un correo para elegir tu contraseña nueva.",
    );
    expect(MFA_ANNUL_DONE_NO_EMAIL_MESSAGE).toBe(
      "Anulamos la activación y cerramos todas las sesiones. Para entrar, usa «¿Olvidaste tu contraseña?».",
    );
    expect(MFA_ANNUL_FAILED_MESSAGE).toBe(
      "No pudimos terminar. Abre de nuevo el enlace en unos minutos.",
    );
  });

  it("el correo de recuperación usa el flujo de «¿Olvidaste tu contraseña?» con el correo que entrega el servicio, y vuelve a /auth/recuperar", async () => {
    annulSecondStep.mockImplementation(async (_token, _request, send) => {
      expect(await send("duena@ejemplo.test")).toBe(true);
      return { status: "annulled", recoveryEmailSent: true };
    });
    await annulSecondStepAction(IDLE, form({ token: "x" }));
    expect(resetPasswordForEmail).toHaveBeenCalledWith("duena@ejemplo.test", {
      redirectTo: "https://app.ejemplo.test/auth/recuperar",
    });
  });

  it("si Supabase rechaza el pedido, lo anota solo con su código y dice que no salió", async () => {
    resetPasswordForEmail.mockResolvedValue({
      error: { code: "over_email_send_rate_limit", status: 429 },
    });
    annulSecondStep.mockImplementation(async (_token, _request, send) => {
      expect(await send("duena@ejemplo.test")).toBe(false);
      return { status: "annulled", recoveryEmailSent: false };
    });
    await annulSecondStepAction(IDLE, form({ token: "x" }));
    expect(serverLog).toHaveBeenCalledWith("warn", "mfa_annul_recovery_request_failed", {
      code: "over_email_send_rate_limit",
    });
    expect(JSON.stringify(serverLog.mock.calls)).not.toContain("duena@");
  });
});
