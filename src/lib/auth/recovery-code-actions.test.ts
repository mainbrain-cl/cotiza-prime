import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FormState } from "@/lib/auth/form-state";
import { RedirectSignal } from "@/test/supabase-mock";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ana@ejemplo.test",
  emailVerified: true,
};
const FACTOR_ID = "22222222-2222-4222-8222-222222222222";
const SET_ID = "33333333-3333-4333-8333-333333333333";
const IP = "203.0.113.7";
const PASSWORD = "Contrasena-Muy-Secreta-9";
const APP_CODE = "123456";
const BACKUP_CODE = "7KQM-3XHP-W2RT";
const ISSUED = {
  ok: true,
  recoveryCodes: ["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"],
  setId: SET_ID,
};

const challengeAndVerify = vi.fn();
const listFactors = vi.fn();
const tableReads = vi.fn();
const supabase = { auth: { mfa: { challengeAndVerify, listFactors } }, from: tableReads };
const logAuditEvent = vi.fn();
const serverLog = vi.fn();
const requireUser = vi.fn();
const confirmPassword = vi.fn();
const isSecondStepIpLocked = vi.fn();
const beginSecondStepAttempt = vi.fn();
const releaseTotpCode = vi.fn();
const recordSecondStepFailure = vi.fn();
const clearSecondStepFailures = vi.fn();
const consumeTotpCode = vi.fn();
const issueRecoveryCodes = vi.fn();
const sendRecoveryCodesCreatedNotice = vi.fn();
const acknowledgeRecoveryCodes = vi.fn();

vi.mock("@/lib/audit/log", () => ({ logAuditEvent: (e: unknown) => logAuditEvent(e) }));
vi.mock("@/lib/log/server-log", () => ({
  serverLog: (...args: unknown[]) => serverLog(...args),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: () => requireUser() }));
vi.mock("@/lib/auth/reauth", () => ({
  confirmPassword: (...args: unknown[]) => confirmPassword(...args),
}));
vi.mock("@/lib/auth/recovery-code-issue", () => ({
  issueRecoveryCodes: (...args: unknown[]) => issueRecoveryCodes(...args),
}));
vi.mock("@/lib/http/request-context", () => ({
  getRequestContext: async () => ({ requestId: "r", clientIp: IP, userAgent: null }),
}));
vi.mock("@/lib/security/login-rate-limit", () => ({
  RATE_LIMITED_MESSAGE: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
  isSecondStepIpLocked: (...args: unknown[]) => isSecondStepIpLocked(...args),
  beginSecondStepAttempt: (...args: unknown[]) => beginSecondStepAttempt(...args),
  releaseTotpCode: (...args: unknown[]) => releaseTotpCode(...args),
  recordSecondStepFailure: (...args: unknown[]) => recordSecondStepFailure(...args),
  clearSecondStepFailures: (...args: unknown[]) => clearSecondStepFailures(...args),
  consumeTotpCode: (...args: unknown[]) => consumeTotpCode(...args),
}));
vi.mock("@/lib/security/mfa-account-notice-send", () => ({
  sendRecoveryCodesCreatedNotice: (...args: unknown[]) => sendRecoveryCodesCreatedNotice(...args),
}));
vi.mock("@/lib/security/mfa-recovery-gateway", () => ({
  MfaRecoveryGatewayError: class extends Error {
    code = "gateway";
  },
  acknowledgeRecoveryCodes: (...args: unknown[]) => acknowledgeRecoveryCodes(...args),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));

const { acknowledgeRecoveryCodesAction, regenerateRecoveryCodesAction } =
  await import("./recovery-code-actions");

const IDLE = { status: "idle" } as const;
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const fields = (extra: Record<string, string> = {}) =>
  form({ code: APP_CODE, password: PASSWORD, ...extra });
/** La acción vista como el estado de un formulario (errores); el éxito se prueba aparte. */
const regenerateForm = async (data: FormData) =>
  (await regenerateRecoveryCodesAction(IDLE, data)) as FormState;

beforeEach(() => {
  for (const mock of [
    challengeAndVerify,
    listFactors,
    tableReads,
    logAuditEvent,
    serverLog,
    requireUser,
    confirmPassword,
    isSecondStepIpLocked,
    beginSecondStepAttempt,
    releaseTotpCode,
    recordSecondStepFailure,
    clearSecondStepFailures,
    consumeTotpCode,
    issueRecoveryCodes,
    sendRecoveryCodesCreatedNotice,
    acknowledgeRecoveryCodes,
  ]) {
    mock.mockReset();
  }
  requireUser.mockResolvedValue(USER);
  confirmPassword.mockResolvedValue({ ok: true });
  isSecondStepIpLocked.mockResolvedValue(false);
  beginSecondStepAttempt.mockResolvedValue("none");
  consumeTotpCode.mockResolvedValue(true);
  recordSecondStepFailure.mockResolvedValue(undefined);
  listFactors.mockResolvedValue({
    data: { all: [{ id: FACTOR_ID, status: "verified", factor_type: "totp" }] },
    error: null,
  });
  challengeAndVerify.mockResolvedValue({ data: {}, error: null });
  issueRecoveryCodes.mockResolvedValue(ISSUED);
  sendRecoveryCodesCreatedNotice.mockResolvedValue(true);
});

describe("regenerateRecoveryCodesAction (crear o generar códigos de respaldo)", () => {
  it("exige una sesión completa: sin ella la redirección la hace session.ts y no se consulta nada", async () => {
    requireUser.mockRejectedValue(new RedirectSignal("/ingresar"));
    await expect(regenerateRecoveryCodesAction(IDLE, fields())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(confirmPassword).not.toHaveBeenCalled();
    expect(listFactors).not.toHaveBeenCalled();
  });

  it("un código de 6 números mal escrito o sin contraseña da error en su campo y no consulta nada", async () => {
    const badCode = await regenerateForm(fields({ code: "12" }));
    expect(badCode.fieldErrors?.code).toBeTruthy();
    const noPassword = await regenerateForm(fields({ password: "" }));
    expect(noPassword.fieldErrors?.password).toBeTruthy();
    expect(confirmPassword).not.toHaveBeenCalled();
    expect(beginSecondStepAttempt).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("pide el código de la APLICACIÓN: un código de respaldo se rechaza en el campo, sin contar intentos ni consultar nada", async () => {
    for (const typed of [BACKUP_CODE, "7kqm3xhpw2rt", "7KQM 3XHP W2RT"]) {
      const state = await regenerateForm(fields({ code: typed }));
      expect(state.status).toBe("error");
      expect(state.fieldErrors?.code).toMatch(/no un código de respaldo/);
    }
    expect(confirmPassword).not.toHaveBeenCalled();
    expect(beginSecondStepAttempt).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(issueRecoveryCodes).not.toHaveBeenCalled();
  });

  it("la contraseña se pide para «regenerate», ANTES de contadores, factores y Supabase", async () => {
    await regenerateRecoveryCodesAction(IDLE, fields());
    expect(confirmPassword).toHaveBeenCalledWith(USER, PASSWORD, "regenerate");
    const passwordAt = confirmPassword.mock.invocationCallOrder[0];
    for (const later of [
      isSecondStepIpLocked,
      beginSecondStepAttempt,
      consumeTotpCode,
      listFactors,
      challengeAndVerify,
      issueRecoveryCodes,
    ]) {
      expect(passwordAt, later.getMockName()).toBeLessThan(later.mock.invocationCallOrder[0]);
    }
  });

  it("contraseña incorrecta: error en su campo y no se toca nada más (ni contadores, ni código, ni códigos nuevos)", async () => {
    confirmPassword.mockResolvedValue({
      ok: false,
      reason: "wrong_password",
      message: "La contraseña no es correcta.",
    });
    const state = await regenerateRecoveryCodesAction(IDLE, fields());
    expect(state).toEqual({
      status: "error",
      fieldErrors: { password: "La contraseña no es correcta." },
    });
    for (const untouched of [
      beginSecondStepAttempt,
      consumeTotpCode,
      listFactors,
      challengeAndVerify,
      issueRecoveryCodes,
      sendRecoveryCodesCreatedNotice,
      logAuditEvent,
    ]) {
      expect(untouched).not.toHaveBeenCalled();
    }
  });

  it.each(["locked", "rate_limited", "unavailable", "other_account"] as const)(
    "la comprobación de la contraseña no pudo terminar (%s): mensaje general y nada de lo demás se toca",
    async (reason) => {
      confirmPassword.mockResolvedValue({ ok: false, reason, message: "Mensaje de prueba." });
      expect(await regenerateRecoveryCodesAction(IDLE, fields())).toEqual({
        status: "error",
        message: "Mensaje de prueba.",
      });
      expect(beginSecondStepAttempt).not.toHaveBeenCalled();
      expect(issueRecoveryCodes).not.toHaveBeenCalled();
    },
  );

  it("usa los contadores del camino «manage» y verifica el código de la aplicación en UNA llamada con el factor verificado", async () => {
    await regenerateRecoveryCodesAction(IDLE, fields());
    expect(beginSecondStepAttempt).toHaveBeenCalledWith(USER.id, "manage");
    expect(challengeAndVerify).toHaveBeenCalledTimes(1);
    expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: FACTOR_ID, code: APP_CODE });
    expect(clearSecondStepFailures).toHaveBeenCalledWith(USER.id, "manage");
    expect(recordSecondStepFailure).not.toHaveBeenCalled();
  });

  it("bloqueada (IP, ventana o día): no llama a Supabase y el bloqueo del día usa el mensaje del camino «manage»", async () => {
    beginSecondStepAttempt.mockResolvedValue("short");
    expect((await regenerateForm(fields())).message).toMatch(/Demasiados intentos/);
    beginSecondStepAttempt.mockResolvedValue("day");
    expect((await regenerateForm(fields())).message).toMatch(/mañana/);
    isSecondStepIpLocked.mockResolvedValue(true);
    expect((await regenerateForm(fields())).message).toMatch(/Demasiados intentos/);
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(issueRecoveryCodes).not.toHaveBeenCalled();
  });

  it("código ya usado: se rechaza antes de verificar y no suma fallo", async () => {
    consumeTotpCode.mockResolvedValue(false);
    const state = await regenerateForm(fields());
    expect(state.message).toMatch(/ya se usó/);
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(recordSecondStepFailure).not.toHaveBeenCalled();
  });

  it("código incorrecto: suma un fallo a los contadores de «manage», deja auditoría y NO crea códigos", async () => {
    challengeAndVerify.mockResolvedValue({
      error: { code: "mfa_verification_failed", status: 422 },
    });
    const state = await regenerateForm(fields());
    expect(state.message).toMatch(/El código no coincide/);
    expect(recordSecondStepFailure).toHaveBeenCalledWith(USER.id, "manage", IP);
    expect(logAuditEvent.mock.calls.map(([event]) => event)).toContainEqual(
      expect.objectContaining({
        action: "session.mfa_failed",
        details: { reason: "mfa_invalid_code", stage: "manage", factorType: "totp" },
      }),
    );
    expect(issueRecoveryCodes).not.toHaveBeenCalled();
    expect(sendRecoveryCodesCreatedNotice).not.toHaveBeenCalled();
  });

  it("si Supabase falla por otra cosa, el código se libera, no suma fallo y el mensaje es de reintentar", async () => {
    challengeAndVerify.mockResolvedValue({
      error: { code: "mfa_ip_address_mismatch", status: 400 },
    });
    const state = await regenerateForm(fields());
    expect(state.message).toMatch(/No pudimos verificar el código/);
    expect(releaseTotpCode).toHaveBeenCalledWith(USER.id, APP_CODE);
    expect(recordSecondStepFailure).not.toHaveBeenCalled();
    expect(issueRecoveryCodes).not.toHaveBeenCalled();
  });

  it("sin un factor verificado (o sin poder leerlos): no verifica, libera el código y no crea nada", async () => {
    listFactors.mockResolvedValue({
      data: { all: [{ id: FACTOR_ID, status: "unverified", factor_type: "totp" }] },
      error: null,
    });
    expect((await regenerateForm(fields())).status).toBe("error");
    listFactors.mockResolvedValue({ data: null, error: { code: "x" } });
    expect((await regenerateForm(fields())).status).toBe("error");
    expect(releaseTotpCode).toHaveBeenCalledTimes(2);
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(issueRecoveryCodes).not.toHaveBeenCalled();
  });

  it("éxito: crea el juego con el factor verificado y devuelve los códigos (ya formateados) y el identificador del juego", async () => {
    const result = await regenerateRecoveryCodesAction(IDLE, fields());
    expect(result).toEqual({
      status: "created",
      recoveryCodes: ISSUED.recoveryCodes,
      setId: SET_ID,
    });
    expect(issueRecoveryCodes).toHaveBeenCalledWith(USER.id, FACTOR_ID, "regenerate");
    // Los códigos se crean DESPUÉS de verificar el código de la aplicación.
    expect(issueRecoveryCodes.mock.invocationCallOrder[0]).toBeGreaterThan(
      challengeAndVerify.mock.invocationCallOrder[0],
    );
  });

  it("después de crear los códigos, avisa por correo al de la cuenta (de mejor esfuerzo)", async () => {
    await regenerateRecoveryCodesAction(IDLE, fields());
    expect(sendRecoveryCodesCreatedNotice).toHaveBeenCalledWith(USER.email);
    expect(sendRecoveryCodesCreatedNotice.mock.invocationCallOrder[0]).toBeGreaterThan(
      issueRecoveryCodes.mock.invocationCallOrder[0],
    );
  });

  it("si el correo de aviso no sale, la creación igual vale y se entregan los códigos", async () => {
    sendRecoveryCodesCreatedNotice.mockResolvedValue(false);
    expect((await regenerateRecoveryCodesAction(IDLE, fields())).status).toBe("created");
  });

  it("si no se pueden crear los códigos: mensaje claro, sin correo y el código de la aplicación NO se libera (ya se usó)", async () => {
    issueRecoveryCodes.mockResolvedValue({ ok: false, reason: "error" });
    const state = await regenerateForm(fields());
    expect(state.status).toBe("error");
    expect(state.message).toMatch(/No pudimos crear tus códigos de respaldo/);
    expect(sendRecoveryCodesCreatedNotice).not.toHaveBeenCalled();
    issueRecoveryCodes.mockResolvedValue({ ok: false, reason: "busy" });
    expect((await regenerateForm(fields())).message).toMatch(/usando un código de respaldo/);
  });

  it("la contraseña y los códigos nunca llegan a la auditoría ni al registro ni vuelven en un error", async () => {
    const recordedAfter = async () =>
      JSON.stringify([...logAuditEvent.mock.calls, ...serverLog.mock.calls]);
    challengeAndVerify.mockResolvedValueOnce({
      error: { code: "mfa_verification_failed", status: 422 },
    });
    const failed = await regenerateForm(fields());
    await regenerateRecoveryCodesAction(IDLE, fields({ code: "654321" }));
    const recorded = await recordedAfter();
    expect(recorded).not.toContain(PASSWORD);
    for (const code of ISSUED.recoveryCodes) expect(recorded).not.toContain(code);
    expect(JSON.stringify(failed)).not.toContain(PASSWORD);
    expect(failed.values).toBeUndefined();
  });

  it("es de la cuenta: no mira rol ni organización y no lee tablas", async () => {
    await regenerateRecoveryCodesAction(IDLE, fields());
    expect(tableReads).not.toHaveBeenCalled();
  });
});

describe("acknowledgeRecoveryCodesAction («Listo»)", () => {
  beforeEach(() => {
    acknowledgeRecoveryCodes.mockResolvedValue(true);
  });

  it("exige una sesión completa", async () => {
    requireUser.mockRejectedValue(new RedirectSignal("/ingresar"));
    await expect(acknowledgeRecoveryCodesAction(SET_ID)).rejects.toBeInstanceOf(RedirectSignal);
    expect(acknowledgeRecoveryCodes).not.toHaveBeenCalled();
  });

  it("confirma el juego de la persona de la sesión", async () => {
    expect(await acknowledgeRecoveryCodesAction(SET_ID)).toEqual({ status: "ok" });
    expect(acknowledgeRecoveryCodes).toHaveBeenCalledWith(USER.id, SET_ID);
  });

  it("un identificador que no es de un juego no consulta la base", async () => {
    for (const bad of ["", "no-es-un-uuid", "x".repeat(500)]) {
      expect((await acknowledgeRecoveryCodesAction(bad)).status).toBe("error");
    }
    expect(acknowledgeRecoveryCodes).not.toHaveBeenCalled();
  });

  it("un juego que ya no es el vigente (o ajeno) responde error sin detalles", async () => {
    acknowledgeRecoveryCodes.mockResolvedValue(false);
    const result = await acknowledgeRecoveryCodesAction(SET_ID);
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain(USER.id);
  });

  it("si la base falla, avisa sin detalles y registra solo el código del error", async () => {
    acknowledgeRecoveryCodes.mockRejectedValue(new Error("boom"));
    const result = await acknowledgeRecoveryCodesAction(SET_ID);
    expect(result.status).toBe("error");
    expect(serverLog).toHaveBeenCalledWith("error", "mfa_recovery_acknowledge_failed", {
      code: "unexpected",
    });
  });
});
