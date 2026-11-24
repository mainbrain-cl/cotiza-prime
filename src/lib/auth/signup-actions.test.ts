import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// El registro en dos pasos (H-116): pedir el enlace, canjearlo y terminar la cuenta. Todo con falsos de Supabase.

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  verify: vi.fn(),
  logAuditEvent: vi.fn(),
  serverLog: vi.fn(),
  sendSignupLink: vi.fn(),
  isSignupLocked: vi.fn(),
  recordSignupAttempt: vi.fn(),
  consumeSignupLinkQuota: vi.fn(),
  getSessionState: vi.fn(),
  hasEmailLinkSession: vi.fn(),
  isAccountReady: vi.fn(),
  hasPendingInvitation: vi.fn(),
  createClient: vi.fn(),
  verifyOtp: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  rpc: vi.fn(),
  order: [] as string[],
}));
class Redirected extends Error {
  constructor(readonly to: string) {
    super(to);
  }
}
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));
vi.mock("@/lib/antibot", () => ({ getAntibotVerifier: () => ({ verify: mocks.verify }) }));
vi.mock("@/lib/audit/log", () => ({ logAuditEvent: mocks.logAuditEvent }));
vi.mock("@/lib/log/server-log", () => ({ serverLog: mocks.serverLog }));
vi.mock("@/lib/auth/signup-service", () => ({ sendSignupLink: mocks.sendSignupLink }));
vi.mock("@/lib/http/request-context", () => ({
  getAppOrigin: () => "https://app.cotizaprime.example",
  getRequestContext: async () => ({
    requestId: "r",
    clientIp: "203.0.113.7",
    userAgent: "Navegador/1.0",
  }),
}));
vi.mock("@/lib/security/login-rate-limit", () => ({
  RATE_LIMITED_MESSAGE: "Demasiados intentos.",
  emailFingerprint: () => "huella-del-correo",
  isSignupLocked: mocks.isSignupLocked,
  recordSignupAttempt: mocks.recordSignupAttempt,
  consumeSignupLinkQuota: mocks.consumeSignupLinkQuota,
}));
vi.mock("@/lib/auth/session", () => ({
  getSessionState: mocks.getSessionState,
  hasEmailLinkSession: mocks.hasEmailLinkSession,
  isAccountReady: mocks.isAccountReady,
}));
vi.mock("@/lib/team/invitation-cookie", () => ({
  hasPendingInvitation: mocks.hasPendingInvitation,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import {
  SIGNUP_MIN_RESPONSE_MS,
  SETUP_EXPIRED_MESSAGE,
  OTHER_SESSIONS_MESSAGE,
  SETUP_REJECTIONS,
} from "./account-setup";
import { completeAccountSetupAction, confirmEmailLinkAction, signUpAction } from "./signup-actions";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const idle = { status: "idle" } as const;

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Redirected) return error.to;
    throw error;
  }
  throw new Error("se esperaba una redirección");
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  mocks.order.length = 0;
  mocks.after.mockImplementation(() => undefined);
  mocks.verify.mockResolvedValue({ ok: true });
  mocks.isSignupLocked.mockResolvedValue(false);
  mocks.recordSignupAttempt.mockResolvedValue(false);
  mocks.consumeSignupLinkQuota.mockResolvedValue(true);
  mocks.sendSignupLink.mockResolvedValue("sent");
  mocks.hasPendingInvitation.mockResolvedValue(false);
});
afterEach(() => vi.useRealTimers());

describe("signUpAction (paso 1: solo el correo)", () => {
  const valid = () => form({ email: " Nueva@Ejemplo.test ", antibotToken: "test-pass" });

  /** Corre la acción con reloj simulado: la respuesta espera la duración mínima. */
  async function run(data = valid()) {
    vi.useFakeTimers();
    const pending = signUpAction(idle, data);
    await vi.advanceTimersByTimeAsync(SIGNUP_MIN_RESPONSE_MS);
    return pending;
  }

  it("con un correo válido responde «enviado» con el correo normalizado y deja el trabajo caro para DESPUÉS de responder", async () => {
    const state = await run();
    expect(state).toEqual({ status: "sent", values: { email: "nueva@ejemplo.test" } });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    // Todavía no se preparó la cuenta ni se envió nada: eso corre cuando ya se respondió.
    expect(mocks.sendSignupLink).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.sendSignupLink).toHaveBeenCalledWith("nueva@ejemplo.test");
  });

  it("la respuesta es IDÉNTICA y dura lo mismo si el correo ya tenía cuenta, no la tenía o el envío falla", async () => {
    const results = [];
    for (const outcome of ["sent", "already_registered", "not_sent"] as const) {
      mocks.sendSignupLink.mockResolvedValue(outcome);
      mocks.after.mockClear();
      vi.useFakeTimers();
      let done = false;
      const pending = signUpAction(idle, valid()).then((state) => {
        done = true;
        return state;
      });
      await vi.advanceTimersByTimeAsync(SIGNUP_MIN_RESPONSE_MS - 1);
      // Antes de la duración mínima NO responde, pase lo que pase con la cuenta.
      expect(done, outcome).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      results.push(await pending);
      await mocks.after.mock.calls[0][0]();
      vi.useRealTimers();
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it("un correo mal escrito o sin prueba anti-robot se rechaza sin tocar nada", async () => {
    const badEmail = await signUpAction(idle, form({ email: "no-es-correo", antibotToken: "x" }));
    expect(badEmail.status).toBe("error");
    expect(badEmail.fieldErrors?.email).toBeTruthy();
    const noToken = await signUpAction(idle, form({ email: "nueva@ejemplo.test" }));
    expect(noToken.fieldErrors?.antibotToken).toBe("Confirma que no eres un robot.");
    expect(mocks.isSignupLocked).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("comprueba la prueba anti-robot (acción «signup», sitio de APP_ORIGIN, IP de quien pide) y si falla no hace nada más", async () => {
    mocks.verify.mockResolvedValue({ ok: false, reason: "invalid_token" });
    const state = await signUpAction(idle, valid());
    expect(state.status).toBe("error");
    expect(state.message).toBe("No pudimos comprobar que eres una persona. Inténtalo de nuevo.");
    expect(mocks.verify).toHaveBeenCalledWith({
      token: "test-pass",
      remoteIp: "203.0.113.7",
      expectedHostname: "app.cotizaprime.example",
      expectedAction: "signup",
    });
    expect(mocks.consumeSignupLinkQuota).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("si el proveedor anti-robot falla o no está configurado, bloquea (falla cerrado) y no lanza", async () => {
    mocks.verify.mockRejectedValue(new Error("config"));
    const state = await signUpAction(idle, valid());
    expect(state.status).toBe("error");
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("el tope por IP bloquea ANTES de la prueba anti-robot y de cualquier envío; cada intento cuenta", async () => {
    mocks.isSignupLocked.mockResolvedValue(true);
    const state = await signUpAction(idle, valid());
    expect(state).toMatchObject({ status: "error", message: "Demasiados intentos." });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
    mocks.isSignupLocked.mockResolvedValue(false);
    await run();
    expect(mocks.recordSignupAttempt).toHaveBeenCalledWith("203.0.113.7");
  });

  it("el tope por correo (1 por minuto y 3 por hora) bloquea sin enviar y cuenta el pedido tenga o no cuenta el correo", async () => {
    mocks.consumeSignupLinkQuota.mockResolvedValue(false);
    const state = await signUpAction(idle, valid());
    expect(state).toMatchObject({ status: "error", message: "Demasiados intentos." });
    expect(mocks.consumeSignupLinkQuota).toHaveBeenCalledWith("nueva@ejemplo.test");
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "denied",
        details: { emailHash: "huella-del-correo", stage: "blocked_email" },
      }),
    );
  });

  it("la auditoría guarda solo la huella del correo, nunca el correo", async () => {
    await run();
    const logged = JSON.stringify([
      ...mocks.logAuditEvent.mock.calls,
      ...mocks.serverLog.mock.calls,
    ]);
    expect(logged).toContain("huella-del-correo");
    expect(logged).not.toContain("nueva@ejemplo.test");
  });
});

describe("confirmEmailLinkAction (paso 2: el clic canjea el enlace)", () => {
  beforeEach(() => {
    mocks.createClient.mockResolvedValue({ auth: { verifyOtp: mocks.verifyOtp } });
    mocks.verifyOtp.mockResolvedValue({ data: { session: { access_token: "x" } }, error: null });
  });

  it("canjea el código como invitación y lleva a /crear-cuenta; el tipo que traiga el formulario no cuenta", async () => {
    const to = await redirectOf(() =>
      confirmEmailLinkAction(
        { status: "idle" },
        form({ token_hash: "abc123_-XYZ.9", type: "recovery" }),
      ),
    );
    expect(to).toBe("/crear-cuenta");
    expect(mocks.verifyOtp).toHaveBeenCalledWith({ token_hash: "abc123_-XYZ.9", type: "invite" });
  });

  it("sin código, o con uno que no tiene forma de código, no consulta a Supabase y dice que el enlace ya no sirve", async () => {
    for (const token of [undefined, "", "tiene espacios", "a".repeat(300), "a/b"]) {
      const data = token === undefined ? form({}) : form({ token_hash: token });
      const state = await confirmEmailLinkAction({ status: "idle" }, data);
      expect(state, String(token)).toEqual({ status: "error", expired: true });
    }
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("un enlace usado o vencido (4xx) dice «ya no sirve» sin distinguir cuál fue", async () => {
    for (const error of [
      { code: "otp_expired", status: 403 },
      { code: "validation_failed", status: 422 },
    ]) {
      mocks.verifyOtp.mockResolvedValue({ data: { session: null }, error });
      const state = await confirmEmailLinkAction(
        { status: "idle" },
        form({ token_hash: "abc12345" }),
      );
      expect(state).toEqual({ status: "error", expired: true });
    }
  });

  it("si falla por otra cosa (servidor caído, sin respuesta) se puede reintentar: NO dice que el enlace venció", async () => {
    for (const error of [{ status: 502 }, { code: "unexpected_failure", status: 500 }, {}]) {
      mocks.verifyOtp.mockResolvedValue({ data: { session: null }, error });
      const state = await confirmEmailLinkAction(
        { status: "idle" },
        form({ token_hash: "abc12345" }),
      );
      expect(state.expired).toBeUndefined();
      expect(state.message).toMatch(/No pudimos confirmar tu correo/);
    }
    expect(mocks.serverLog).toHaveBeenCalled();
    expect(JSON.stringify(mocks.serverLog.mock.calls)).not.toContain("abc12345");
  });

  it("el límite de Supabase se dice como «demasiados intentos»", async () => {
    mocks.verifyOtp.mockResolvedValue({
      data: { session: null },
      error: { status: 429, code: "over_request_rate_limit" },
    });
    const state = await confirmEmailLinkAction(
      { status: "idle" },
      form({ token_hash: "abc12345" }),
    );
    expect(state.message).toMatch(/Demasiados intentos/);
    expect(state.expired).toBeUndefined();
  });

  it("sin sesión en la respuesta tampoco se sigue", async () => {
    mocks.verifyOtp.mockResolvedValue({ data: { session: null }, error: null });
    const state = await confirmEmailLinkAction(
      { status: "idle" },
      form({ token_hash: "abc12345" }),
    );
    expect(state).toEqual({ status: "error", expired: true });
  });
});

describe("completeAccountSetupAction (paso 3: nombre, contraseña y términos)", () => {
  const USER = { id: "u1", email: "nueva@ejemplo.test", emailVerified: true };
  const valid = () =>
    form({
      fullName: "  Ana Pérez ",
      password: "una-clave-bien-larga",
      confirmPassword: "una-clave-bien-larga",
      acceptLegal: "on",
      termsVersion: "2026-10-01-preliminar",
      privacyVersion: "2026-10-01-preliminar",
    });
  const SETUP_ARGS = {
    p_full_name: "Ana Pérez",
    p_terms_version: "2026-10-01-preliminar",
    p_privacy_version: "2026-10-01-preliminar",
  };
  const run = (data = valid()) => completeAccountSetupAction({ status: "idle" }, data);
  const answers = (...results: Array<Record<string, unknown>>) => {
    mocks.rpc.mockImplementation(async (name: string) => {
      mocks.order.push(name);
      const next = name === "account_setup_preflight" ? results[0] : results[1];
      return { data: next, error: null };
    });
  };

  beforeEach(() => {
    mocks.getSessionState.mockResolvedValue({ status: "complete", user: USER });
    mocks.isAccountReady.mockResolvedValue(false);
    mocks.hasEmailLinkSession.mockResolvedValue(true);
    mocks.createClient.mockImplementation(async () => ({
      auth: { updateUser: mocks.updateUser, signOut: mocks.signOut },
      rpc: mocks.rpc,
    }));
    mocks.updateUser.mockImplementation(async () => {
      mocks.order.push("updateUser");
      return { data: {}, error: null };
    });
    mocks.signOut.mockImplementation(async () => {
      mocks.order.push("signOut");
      return { error: null };
    });
    answers({ result: "ok" }, { result: "completed", already_ready: false });
  });

  it("el orden es: validar sin escribir → contraseña → cerrar las otras sesiones → terminar; y va a crear la primera organización", async () => {
    expect(await redirectOf(run)).toBe("/organizaciones/nueva");
    expect(mocks.order).toEqual([
      "account_setup_preflight",
      "updateUser",
      "signOut",
      "complete_account_setup",
    ]);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "account_setup_preflight", SETUP_ARGS);
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "complete_account_setup", SETUP_ARGS);
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: "una-clave-bien-larga" });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "others" });
  });

  it("con una invitación guardada en este navegador sigue a la invitación", async () => {
    mocks.hasPendingInvitation.mockResolvedValue(true);
    expect(await redirectOf(run)).toBe("/invitacion");
  });

  it("la base recibe la IP y el navegador de quien termina (van con la aceptación de los términos)", async () => {
    await redirectOf(run);
    expect(mocks.createClient).toHaveBeenCalledWith({
      "x-cp-client-ip": "203.0.113.7",
      "user-agent": "Navegador/1.0",
    });
  });

  it.each(Object.keys(SETUP_REJECTIONS))(
    "si la validación responde %s, dice su mensaje y NO fija la contraseña ni cierra sesiones",
    async (result) => {
      answers({ result }, { result: "completed" });
      const state = await run();
      const rejection = SETUP_REJECTIONS[result as keyof typeof SETUP_REJECTIONS];
      expect(state.status).toBe("error");
      if (rejection.field) expect(state.fieldErrors?.[rejection.field]).toBe(rejection.message);
      else expect(state.message).toBe(rejection.message);
      expect(Boolean(state.expired)).toBe(Boolean(rejection.expired));
      expect(mocks.updateUser).not.toHaveBeenCalled();
      expect(mocks.signOut).not.toHaveBeenCalled();
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
      // Lo escrito se conserva (nunca la contraseña).
      // Lo escrito vuelve (nombre y casilla de términos), salvo si cambiaron los términos: hay que aceptarlos de nuevo.
      expect(state.values).toEqual(
        result === "legal_changed"
          ? { fullName: "  Ana Pérez " }
          : { fullName: "  Ana Pérez ", acceptLegal: "on" },
      );
    },
  );

  it("los mensajes de cada resultado son claros y los de seguridad mandan a escribir al equipo", () => {
    expect(SETUP_REJECTIONS.not_email_link.message).toMatch(/enlace venció/);
    expect(SETUP_REJECTIONS.unverified.message).toMatch(/confirma tu correo/);
    expect(SETUP_REJECTIONS.email_changed.message).toMatch(/equipo de Cotiza Prime/);
    expect(SETUP_REJECTIONS.factor_present.message).toMatch(/equipo de Cotiza Prime/);
    expect(SETUP_REJECTIONS.legal_changed.message).toMatch(/Recarga la página/);
    expect(SETUP_REJECTIONS.invalid_name.field).toBe("fullName");
  });

  it("una sesión cerrada o sin sesión (la base LANZA el error) se trata como enlace vencido", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "session_closed" },
    });
    expect(await run()).toMatchObject({
      status: "error",
      expired: true,
      message: SETUP_EXPIRED_MESSAGE,
    });
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("con el segundo paso pendiente va a escribir el código", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "second_step_required" },
    });
    expect(await redirectOf(run)).toBe("/ingresar/codigo");
  });

  it("una cuenta ya terminada (doble clic) sigue de largo SIN tocar la contraseña", async () => {
    mocks.isAccountReady.mockResolvedValue(true);
    expect(await redirectOf(run)).toBe("/organizaciones/nueva");
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("sin sesión pide un enlace nuevo; con una sesión de contraseña tampoco hace nada", async () => {
    mocks.getSessionState.mockResolvedValue({ status: "signed_out" });
    expect(await run()).toMatchObject({ status: "error", expired: true });
    mocks.getSessionState.mockResolvedValue({ status: "complete", user: USER });
    mocks.hasEmailLinkSession.mockResolvedValue(false);
    expect(await run()).toMatchObject({ status: "error", expired: true });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("con sesión parcial (falta el código del segundo paso) va a escribirlo", async () => {
    mocks.getSessionState.mockResolvedValue({
      status: "second_step_pending",
      user: USER,
      factorId: "f",
    });
    expect(await redirectOf(run)).toBe("/ingresar/codigo");
  });

  it("los datos mal escritos se rechazan antes de hablar con la base", async () => {
    const mismatch = form({
      fullName: "Ana",
      password: "una-clave-bien-larga",
      confirmPassword: "otra-clave-distinta",
      acceptLegal: "on",
      termsVersion: "v",
      privacyVersion: "v",
    });
    const state = await run(mismatch);
    expect(state.fieldErrors?.confirmPassword).toBe("Las contraseñas no coinciden.");
    const noLegal = form({
      fullName: "Ana",
      password: "una-clave-bien-larga",
      confirmPassword: "una-clave-bien-larga",
      termsVersion: "v",
      privacyVersion: "v",
    });
    expect((await run(noLegal)).fieldErrors?.acceptLegal).toMatch(/términos/);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("una contraseña débil se dice en su campo; same_password es un reintento y sigue; un enlace de más de 24 h pide uno nuevo", async () => {
    mocks.updateUser.mockResolvedValueOnce({ data: null, error: { code: "weak_password" } });
    const weak = await run();
    expect(weak.fieldErrors?.password).toMatch(/fácil de adivinar/);
    expect(mocks.signOut).not.toHaveBeenCalled();

    mocks.updateUser.mockResolvedValueOnce({ data: null, error: { code: "same_password" } });
    expect(await redirectOf(run)).toBe("/organizaciones/nueva");

    mocks.updateUser.mockResolvedValueOnce({
      data: null,
      error: { code: "reauthentication_needed" },
    });
    expect(await run()).toMatchObject({ status: "error", expired: true });
  });

  it("si la base ve otra sesión abierta, repite el cierre y reintenta UNA vez", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { result: "ok" }, error: null })
      .mockResolvedValueOnce({ data: { result: "other_sessions" }, error: null })
      .mockResolvedValueOnce({ data: { result: "completed", already_ready: false }, error: null });
    expect(await redirectOf(run)).toBe("/organizaciones/nueva");
    expect(mocks.signOut).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it("si tras reintentar sigue la otra sesión, lo dice y no sigue intentando", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { result: "ok" }, error: null })
      .mockResolvedValue({ data: { result: "other_sessions" }, error: null });
    const state = await run();
    expect(state.message).toBe(OTHER_SESSIONS_MESSAGE);
    expect(mocks.signOut).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it("si cerrar las otras sesiones falla, no se corta: la base decide si quedó alguna", async () => {
    mocks.signOut.mockResolvedValue({ error: { code: "unexpected_failure", status: 500 } });
    expect(await redirectOf(run)).toBe("/organizaciones/nueva");
  });

  it("un rechazo al terminar (por ejemplo cambiaron los términos) se dice sin dar la cuenta por terminada", async () => {
    answers({ result: "ok" }, { result: "legal_changed" });
    const state = await run();
    expect(state.message).toBe(SETUP_REJECTIONS.legal_changed.message);
  });

  it("una respuesta rara de la base nunca cuenta como éxito", async () => {
    answers({ result: "ok" }, { result: "inventado" });
    const state = await run();
    expect(state.status).toBe("error");
    answers({ nada: true }, {});
    expect((await run()).status).toBe("error");
  });

  it("ni la contraseña ni el correo llegan a un registro", async () => {
    mocks.updateUser.mockResolvedValueOnce({
      data: null,
      error: { code: "unexpected_failure", status: 500 },
    });
    await run();
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await run();
    const logged = JSON.stringify([
      ...mocks.serverLog.mock.calls,
      ...mocks.logAuditEvent.mock.calls,
    ]);
    expect(logged).not.toContain("una-clave-bien-larga");
    expect(logged).not.toContain("nueva@ejemplo.test");
  });
});
