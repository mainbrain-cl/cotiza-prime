import { beforeEach, describe, expect, it, vi } from "vitest";

// «Pedir la contraseña de nuevo» (H-004b, §3.1): el correo sale de la sesión, usa el límite de intentos del ingreso, abre
// una sesión desechable y la cierra, y nunca registra la contraseña ni el correo.

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ana@ejemplo.test",
  emailVerified: true,
};
const IP = "203.0.113.7";
const PASSWORD = "Contrasena-Muy-Secreta-9";

const signInWithPassword = vi.fn();
const signOut = vi.fn();
const createClient = vi.fn();
const getSessionState = vi.fn();
const isLoginLocked = vi.fn();
const recordLoginFailure = vi.fn();
const clearLoginFailures = vi.fn();
const logAuditEvent = vi.fn();
const serverLog = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClient(...args),
}));
vi.mock("@/lib/auth/session", () => ({ getSessionState: () => getSessionState() }));
vi.mock("@/lib/http/request-context", () => ({
  getRequestContext: async () => ({ requestId: "r", clientIp: IP, userAgent: null }),
}));
vi.mock("@/lib/security/login-rate-limit", () => ({
  RATE_LIMITED_MESSAGE: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
  isLoginLocked: (...args: unknown[]) => isLoginLocked(...args),
  recordLoginFailure: (...args: unknown[]) => recordLoginFailure(...args),
  clearLoginFailures: (...args: unknown[]) => clearLoginFailures(...args),
}));
vi.mock("@/lib/audit/log", () => ({ logAuditEvent: (event: unknown) => logAuditEvent(event) }));
vi.mock("@/lib/log/server-log", () => ({
  serverLog: (...args: unknown[]) => serverLog(...args),
}));

const { confirmPassword } = await import("./reauth");

beforeEach(() => {
  for (const mock of [
    signInWithPassword,
    signOut,
    createClient,
    getSessionState,
    isLoginLocked,
    recordLoginFailure,
    clearLoginFailures,
    logAuditEvent,
    serverLog,
  ]) {
    mock.mockReset();
  }
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:56321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-de-prueba");
  createClient.mockReturnValue({ auth: { signInWithPassword, signOut } });
  getSessionState.mockResolvedValue({
    status: "complete",
    user: USER,
    secondStep: { active: false, since: null },
  });
  isLoginLocked.mockResolvedValue(false);
  recordLoginFailure.mockResolvedValue(false);
  clearLoginFailures.mockResolvedValue(undefined);
  signInWithPassword.mockResolvedValue({ data: { user: { id: USER.id } }, error: null });
  signOut.mockResolvedValue({ error: null });
});

const auditDetails = () => logAuditEvent.mock.calls.map(([event]) => event);
const WRONG = { data: { user: null }, error: { code: "invalid_credentials", status: 400 } };

describe("confirmPassword", () => {
  it("el correo sale de la SESIÓN (nunca del formulario) y la contraseña se prueba con un cliente desechable sin cookies", async () => {
    const result = await confirmPassword(USER, PASSWORD, "enroll");
    expect(result).toEqual({ ok: true });
    expect(signInWithPassword).toHaveBeenCalledWith({ email: USER.email, password: PASSWORD });
    const [url, key, options] = createClient.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:56321");
    expect(key).toBe("anon-de-prueba");
    expect(options.auth).toEqual({
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    });
  });

  it("si la sesión es de otra persona o no hay sesión, no se comprueba nada y queda en la auditoría", async () => {
    getSessionState.mockResolvedValue({
      status: "complete",
      user: { ...USER, id: "99999999-9999-4999-8999-999999999999" },
      secondStep: { active: false, since: null },
    });
    const result = await confirmPassword(USER, PASSWORD, "enroll");
    expect(result).toMatchObject({ ok: false, reason: "other_account" });
    getSessionState.mockResolvedValue({ status: "signed_out" });
    expect(await confirmPassword(USER, PASSWORD, "enroll")).toMatchObject({
      ok: false,
      reason: "other_account",
    });
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(isLoginLocked).not.toHaveBeenCalled();
  });

  it("si la cuenta o la IP están bloqueadas, no llama a Supabase ni suma fallos", async () => {
    isLoginLocked.mockResolvedValue(true);
    const result = await confirmPassword(USER, PASSWORD, "enroll");
    expect(result).toMatchObject({ ok: false, reason: "locked" });
    expect(isLoginLocked).toHaveBeenCalledWith(USER.email, IP);
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(recordLoginFailure).not.toHaveBeenCalled();
    expect(auditDetails()).toEqual([
      expect.objectContaining({
        action: "session.reauth_failed",
        result: "denied",
        details: { reason: "locked", purpose: "enroll" },
      }),
    ]);
  });

  it("una contraseña incorrecta suma UN fallo al contador del ingreso, deja auditoría y no cierra sesión (no hubo ninguna)", async () => {
    signInWithPassword.mockResolvedValue(WRONG);
    const result = await confirmPassword(USER, PASSWORD, "enroll");
    expect(result).toEqual({
      ok: false,
      reason: "wrong_password",
      message: "La contraseña no es correcta.",
    });
    expect(recordLoginFailure).toHaveBeenCalledTimes(1);
    expect(recordLoginFailure).toHaveBeenCalledWith(USER.email, IP);
    expect(clearLoginFailures).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(auditDetails()).toEqual([
      expect.objectContaining({
        action: "session.reauth_failed",
        result: "failure",
        actorUserId: USER.id,
        details: { reason: "wrong_password", purpose: "enroll" },
      }),
    ]);
  });

  it("el fallo que lleva al bloqueo se dice como en el ingreso", async () => {
    signInWithPassword.mockResolvedValue(WRONG);
    recordLoginFailure.mockResolvedValue(true);
    const result = await confirmPassword(USER, PASSWORD, "disable");
    expect(result).toMatchObject({ ok: false, reason: "locked" });
    expect(auditDetails()[0]).toMatchObject({
      result: "denied",
      details: { reason: "locked", purpose: "disable" },
    });
  });

  it("una contraseña correcta cierra la sesión desechable (solo la local) y limpia el contador", async () => {
    const result = await confirmPassword(USER, PASSWORD, "regenerate");
    expect(result).toEqual({ ok: true });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(signOut.mock.invocationCallOrder[0]).toBeLessThan(
      clearLoginFailures.mock.invocationCallOrder[0],
    );
    expect(clearLoginFailures).toHaveBeenCalledWith(USER.email);
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(recordLoginFailure).not.toHaveBeenCalled();
  });

  it("si Supabase responde con OTRA cuenta, se rechaza, se cierra esa sesión y no se limpia el contador", async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: { id: "99999999-9999-4999-8999-999999999999" } },
      error: null,
    });
    const result = await confirmPassword(USER, PASSWORD, "enroll");
    expect(result).toMatchObject({ ok: false, reason: "other_account" });
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(clearLoginFailures).not.toHaveBeenCalled();
    expect(recordLoginFailure).not.toHaveBeenCalled();
  });

  it("un 429 de Supabase NO suma fallo: se dice «demasiados intentos» y queda en la auditoría", async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { code: "over_request_rate_limit", status: 429 },
    });
    const result = await confirmPassword(USER, PASSWORD, "enroll");
    expect(result).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(recordLoginFailure).not.toHaveBeenCalled();
    expect(auditDetails()[0].details).toEqual({ reason: "rate_limited", purpose: "enroll" });
  });

  it.each([
    ["correo sin verificar", { code: "email_not_confirmed", status: 400 }],
    ["una falla desconocida", { code: "unexpected_failure", status: 500 }],
  ])(
    "%s: no se juzgó la contraseña, no suma fallo y se ve «no pudimos comprobar»",
    async (_n, error) => {
      signInWithPassword.mockResolvedValue({ data: { user: null }, error });
      const result = await confirmPassword(USER, PASSWORD, "enroll");
      expect(result).toMatchObject({ ok: false, reason: "unavailable" });
      expect(recordLoginFailure).not.toHaveBeenCalled();
    },
  );

  it("si la llamada a Supabase lanza (red o plazo), no suma fallo y no lanza hacia afuera", async () => {
    signInWithPassword.mockRejectedValue(new Error("fetch failed ana@ejemplo.test"));
    const result = await confirmPassword(USER, PASSWORD, "enroll");
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(recordLoginFailure).not.toHaveBeenCalled();
    // El registro solo lleva un código, nunca el texto del error.
    expect(JSON.stringify(serverLog.mock.calls)).not.toContain("ana@ejemplo.test");
  });

  it("si no se puede cerrar la sesión desechable, la contraseña igual cuenta como correcta y solo se registra el código del error", async () => {
    signOut.mockResolvedValue({ error: { code: "unexpected_failure", status: 500 } });
    const result = await confirmPassword(USER, PASSWORD, "enroll");
    expect(result).toEqual({ ok: true });
    expect(serverLog).toHaveBeenCalledWith("warn", "reauth_sign_out_failed", {
      code: "unexpected_failure",
    });
    signOut.mockRejectedValue(new Error("boom"));
    expect(await confirmPassword(USER, PASSWORD, "enroll")).toEqual({ ok: true });
  });

  it("el cierre de la sesión desechable espera 3 s y comprobar la contraseña 10 s (peor caso 13 s, no 20 s)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await confirmPassword(USER, PASSWORD, "enroll");
    const options = createClient.mock.calls[0]![2] as {
      global: { fetch: (input: string | URL, init?: RequestInit) => Promise<Response> };
    };
    await options.global.fetch("http://127.0.0.1:56321/auth/v1/token?grant_type=password");
    await options.global.fetch("http://127.0.0.1:56321/auth/v1/logout?scope=local");
    await options.global.fetch(new URL("http://127.0.0.1:56321/auth/v1/logout?scope=local"));
    expect(timeoutSpy.mock.calls.map(([ms]) => ms)).toEqual([10_000, 3_000, 3_000]);
    vi.unstubAllGlobals();
    timeoutSpy.mockRestore();
  });

  it("la contraseña ni el correo llegan nunca a serverLog ni a la auditoría (en ningún camino)", async () => {
    signInWithPassword.mockResolvedValue(WRONG);
    await confirmPassword(USER, PASSWORD, "enroll");
    signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { code: "unexpected_failure", status: 500, message: `no ${PASSWORD}` },
    });
    await confirmPassword(USER, PASSWORD, "enroll");
    signInWithPassword.mockRejectedValue(new Error(PASSWORD));
    await confirmPassword(USER, PASSWORD, "enroll");
    isLoginLocked.mockResolvedValue(true);
    await confirmPassword(USER, PASSWORD, "enroll");
    const recorded = JSON.stringify([...logAuditEvent.mock.calls, ...serverLog.mock.calls]);
    expect(recorded).not.toContain(PASSWORD);
    expect(recorded).not.toContain(USER.email);
    expect(logAuditEvent.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
