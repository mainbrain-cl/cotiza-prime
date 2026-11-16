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
const CODE_ID = "44444444-4444-4444-8444-444444444444";
const TENANT_A = "55555555-5555-4555-8555-555555555555";
const TENANT_B = "66666666-6666-4666-8666-666666666666";
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
const signOut = vi.fn();
const supabase = {
  auth: { mfa: { challengeAndVerify, listFactors }, signOut },
  from: tableReads,
};
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
const requirePendingSecondStep = vi.fn();
const hasRecoverySession = vi.fn();
const activeTenantIdsOf = vi.fn();
const logTenantLogins = vi.fn();
const sendRecoveryUsedNotice = vi.fn();
const removeAllFactors = vi.fn();
const hasVerifiedFactor = vi.fn();
const claimRecoveryCode = vi.fn();
const completeRecoveryCode = vi.fn();
const releaseRecoveryCode = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
}));
vi.mock("@/lib/audit/log", () => ({ logAuditEvent: (e: unknown) => logAuditEvent(e) }));
vi.mock("@/lib/log/server-log", () => ({
  serverLog: (...args: unknown[]) => serverLog(...args),
}));
vi.mock("@/lib/auth/session", () => ({
  requireUser: () => requireUser(),
  requirePendingSecondStep: () => requirePendingSecondStep(),
  hasRecoverySession: () => hasRecoverySession(),
}));
vi.mock("@/lib/auth/login-audit", () => ({
  activeTenantIdsOf: (...args: unknown[]) => activeTenantIdsOf(...args),
  logTenantLogins: (...args: unknown[]) => logTenantLogins(...args),
}));
// La huella usa la llave de la plataforma, que aquí no existe: se reemplaza por un texto que muestra de qué cuenta y código sale.
vi.mock("@/lib/auth/recovery-code", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/recovery-code")>()),
  recoveryCodeHash: (userId: string, normalized: string) => `hash(${userId}|${normalized})`,
}));
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
  sendRecoveryUsedNotice: (...args: unknown[]) => sendRecoveryUsedNotice(...args),
}));
vi.mock("@/lib/security/mfa-admin-gateway", () => ({
  MfaAdminGatewayError: class extends Error {
    code = "admin_gateway";
  },
  removeAllFactors: (...args: unknown[]) => removeAllFactors(...args),
  hasVerifiedFactor: (...args: unknown[]) => hasVerifiedFactor(...args),
}));
vi.mock("@/lib/security/mfa-recovery-gateway", () => ({
  MfaRecoveryGatewayError: class extends Error {
    code = "gateway";
  },
  acknowledgeRecoveryCodes: (...args: unknown[]) => acknowledgeRecoveryCodes(...args),
  claimRecoveryCode: (...args: unknown[]) => claimRecoveryCode(...args),
  completeRecoveryCode: (...args: unknown[]) => completeRecoveryCode(...args),
  releaseRecoveryCode: (...args: unknown[]) => releaseRecoveryCode(...args),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));

const { acknowledgeRecoveryCodesAction, regenerateRecoveryCodesAction, verifyRecoveryCodeAction } =
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
    requirePendingSecondStep,
    hasRecoverySession,
    activeTenantIdsOf,
    logTenantLogins,
    sendRecoveryUsedNotice,
    removeAllFactors,
    hasVerifiedFactor,
    claimRecoveryCode,
    completeRecoveryCode,
    releaseRecoveryCode,
    signOut,
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
  requirePendingSecondStep.mockResolvedValue(USER);
  hasRecoverySession.mockResolvedValue(false);
  activeTenantIdsOf.mockResolvedValue([TENANT_A, TENANT_B]);
  logTenantLogins.mockResolvedValue(undefined);
  sendRecoveryUsedNotice.mockResolvedValue(true);
  removeAllFactors.mockResolvedValue(undefined);
  hasVerifiedFactor.mockResolvedValue(true);
  claimRecoveryCode.mockResolvedValue({ codeId: CODE_ID, factorId: FACTOR_ID });
  completeRecoveryCode.mockResolvedValue({ email: "ana@ejemplo.test" });
  releaseRecoveryCode.mockResolvedValue(true);
  signOut.mockResolvedValue({ error: null });
  clearSecondStepFailures.mockResolvedValue(undefined);
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

describe("verifyRecoveryCodeAction (entrar con un código de respaldo)", () => {
  const NORMALIZED = "7KQM3XHPW2RT";
  const HASH = `hash(${USER.id}|${NORMALIZED})`;
  const INVALID_MESSAGE =
    "Ese código de respaldo no sirve. Revisa cómo lo escribiste; cada código sirve una sola vez.";
  const UNFINISHED_MESSAGE = "No pudimos terminar. Intenta de nuevo en unos minutos.";
  const backupForm = (typed: string = BACKUP_CODE) => form({ recoveryCode: typed });
  const verify = async (data: FormData = backupForm()) =>
    (await verifyRecoveryCodeAction(IDLE, data)) as FormState;
  /** La acción termina SIEMPRE con una redirección (éxito): devuelve a dónde. */
  const redirectedTo = async (data: FormData = backupForm()): Promise<string> => {
    try {
      await verifyRecoveryCodeAction(IDLE, data);
    } catch (error) {
      if (error instanceof RedirectSignal) return error.target;
      throw error;
    }
    throw new Error("la acción debía redirigir");
  };
  const auditActions = () => logAuditEvent.mock.calls.map(([event]) => event.action);

  it("solo funciona con la sesión a medias: sin ella la redirección la hace session.ts y no se consulta nada", async () => {
    requirePendingSecondStep.mockRejectedValue(new RedirectSignal("/ingresar"));
    await expect(verifyRecoveryCodeAction(IDLE, backupForm())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    for (const untouched of [
      isSecondStepIpLocked,
      beginSecondStepAttempt,
      claimRecoveryCode,
      removeAllFactors,
      signOut,
    ]) {
      expect(untouched).not.toHaveBeenCalled();
    }
  });

  it("un código mal escrito (o vacío) da error en su campo y no toca la base ni los contadores", async () => {
    for (const typed of [
      "",
      "   ",
      "7KQM-3XHP",
      "7KQM-3XHP-W2RT-ZZZZ",
      "7KQM-3XHP-W2R!",
      "U7KQ-3XHP-W2RT",
    ]) {
      const state = await verify(backupForm(typed));
      expect(state.status, typed).toBe("error");
      expect(state.fieldErrors?.recoveryCode, typed).toBeTruthy();
    }
    for (const untouched of [
      isSecondStepIpLocked,
      beginSecondStepAttempt,
      recordSecondStepFailure,
      claimRecoveryCode,
      removeAllFactors,
      logAuditEvent,
    ]) {
      expect(untouched).not.toHaveBeenCalled();
    }
  });

  it("6 números parecen el código de la aplicación: se le dice, sin contar el intento ni consultar nada", async () => {
    for (const typed of ["123456", "123 456", "123-456"]) {
      const state = await verify(backupForm(typed));
      expect(state.fieldErrors?.recoveryCode).toBe(
        "Eso parece el código de tu aplicación. Aquí va un código de respaldo de 12 letras y números.",
      );
    }
    expect(beginSecondStepAttempt).not.toHaveBeenCalled();
    expect(claimRecoveryCode).not.toHaveBeenCalled();
  });

  it("acepta el código con minúsculas, espacios y guiones: toma la huella de la forma normalizada y de ESA cuenta", async () => {
    await redirectedTo(backupForm(" 7kqm 3xhp-w2rt "));
    expect(claimRecoveryCode).toHaveBeenCalledWith(USER.id, HASH);
  });

  it("con la cuenta bloqueada no se consulta la base: mensaje de bloqueo y auditoría `denied`", async () => {
    beginSecondStepAttempt.mockResolvedValue("short");
    const state = await verify();
    expect(state.message).toMatch(/Demasiados intentos/);
    expect(claimRecoveryCode).not.toHaveBeenCalled();
    expect(removeAllFactors).not.toHaveBeenCalled();
    // El intento era con un código de respaldo: la auditoría anota ese tipo, no «totp».
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.mfa_locked",
        result: "denied",
        details: { reason: "blocked", stage: "sign_in", factorType: "recovery_code" },
      }),
    );
  });

  it("la IP bloqueada también corta antes de consultar la base, sin registrar un intento más de la cuenta", async () => {
    isSecondStepIpLocked.mockResolvedValue(true);
    const state = await verify();
    expect(state.message).toMatch(/Demasiados intentos/);
    expect(beginSecondStepAttempt).not.toHaveBeenCalled();
    expect(claimRecoveryCode).not.toHaveBeenCalled();
  });

  it("el bloqueo de 24 h con la contraseña orienta a recuperarla; por el enlace del correo, no", async () => {
    beginSecondStepAttempt.mockResolvedValue("day");
    expect((await verify()).message).toMatch(/¿Olvidaste tu contraseña\?/);
    hasRecoverySession.mockResolvedValue(true);
    const viaLink = (await verify()).message ?? "";
    expect(viaLink).toMatch(/mañana/);
    expect(viaLink).not.toMatch(/¿Olvidaste tu contraseña\?/);
  });

  it("un código que no sirve suma al contador de ESE camino, deja auditoría y da un solo mensaje", async () => {
    claimRecoveryCode.mockResolvedValue(null);
    const state = await verify();
    expect(state).toEqual({ status: "error", message: INVALID_MESSAGE });
    expect(beginSecondStepAttempt).toHaveBeenCalledWith(USER.id, "password");
    expect(recordSecondStepFailure).toHaveBeenCalledWith(USER.id, "password", IP);
    expect(logAuditEvent).toHaveBeenCalledWith({
      action: "session.mfa_failed",
      result: "failure",
      actorUserId: USER.id,
      details: { reason: "recovery_invalid", stage: "sign_in", factorType: "recovery_code" },
    });
    // No se quitó nada ni se cerró ninguna sesión.
    expect(removeAllFactors).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("por el enlace del correo usa los contadores «recovery» y la etapa «recovery»", async () => {
    hasRecoverySession.mockResolvedValue(true);
    claimRecoveryCode.mockResolvedValue(null);
    await verify();
    expect(beginSecondStepAttempt).toHaveBeenCalledWith(USER.id, "recovery");
    expect(recordSecondStepFailure).toHaveBeenCalledWith(USER.id, "recovery", IP);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { reason: "recovery_invalid", stage: "recovery", factorType: "recovery_code" },
      }),
    );
  });

  it("los intentos con un código de respaldo cuentan en el MISMO contador de ventana del camino: con la ventana llena (5 intentos) el sexto se bloquea", async () => {
    // Esta prueba solo comprueba lo que hace ESTA acción: llamar siempre al mismo contador del camino (`beginSecondStepAttempt`).
    // Los intentos «de la aplicación» se simulan llamando al contador directo, NO pasan por `verifySecondStepAction`: que de verdad
    // se mezclen los dos formularios lo comprueba la prueba de punta a punta (`e2e/mfa-recovery.spec.ts`, «el límite»).
    let attempts = 0;
    beginSecondStepAttempt.mockImplementation(async () => (++attempts > 5 ? "short" : "none"));
    claimRecoveryCode.mockResolvedValue(null);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      // Los intentos 1, 3 y 5 son de esta acción (respaldo); en 2 y 4 se llama al contador directo, como lo hace el otro formulario.
      if (attempt % 2 === 1) await verify();
      else await beginSecondStepAttempt(USER.id, "password");
    }
    expect(beginSecondStepAttempt.mock.calls.every(([, camino]) => camino === "password")).toBe(
      true,
    );
    const sixth = await verify();
    expect(sixth.message).toMatch(/Demasiados intentos/);
    expect(claimRecoveryCode).toHaveBeenCalledTimes(3);
  });

  it("el orden exacto: tomar → cerrar otras sesiones → quitar factores → aviso → cerrar otras sesiones otra vez → completar → limpiar → auditoría → redirección", async () => {
    const target = await redirectedTo();
    expect(target).toBe("/cuenta/seguridad?aviso=respaldo");
    expect(signOut).toHaveBeenCalledTimes(2);
    const order = [
      claimRecoveryCode.mock.invocationCallOrder[0],
      signOut.mock.invocationCallOrder[0],
      removeAllFactors.mock.invocationCallOrder[0],
      sendRecoveryUsedNotice.mock.invocationCallOrder[0],
      signOut.mock.invocationCallOrder[1],
      completeRecoveryCode.mock.invocationCallOrder[0],
      clearSecondStepFailures.mock.invocationCallOrder[0],
      logAuditEvent.mock.invocationCallOrder[0],
      activeTenantIdsOf.mock.invocationCallOrder[0],
      logTenantLogins.mock.invocationCallOrder[0],
    ];
    expect(order.every((position) => position !== undefined)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(claimRecoveryCode).toHaveBeenCalledWith(USER.id, HASH);
    expect(removeAllFactors).toHaveBeenCalledWith(USER.id);
    expect(signOut).toHaveBeenNthCalledWith(1, { scope: "others" });
    expect(signOut).toHaveBeenNthCalledWith(2, { scope: "others" });
    expect(completeRecoveryCode).toHaveBeenCalledWith(CODE_ID);
    expect(clearSecondStepFailures).toHaveBeenCalledWith(USER.id, "password");
    expect(sendRecoveryUsedNotice).toHaveBeenCalledTimes(1);
    expect(sendRecoveryUsedNotice).toHaveBeenCalledWith("ana@ejemplo.test");
    // Nunca se suelta un código que se usó.
    expect(releaseRecoveryCode).not.toHaveBeenCalled();
  });

  it("deja `session.mfa_recovery_used` en la plataforma y en cada organización activa, y el ingreso de cada una", async () => {
    await redirectedTo();
    const used = logAuditEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.action === "session.mfa_recovery_used");
    expect(used).toHaveLength(3);
    expect(used.map((event) => event.tenantId)).toEqual([undefined, TENANT_A, TENANT_B]);
    for (const event of used) {
      expect(event).toMatchObject({
        result: "success",
        actorUserId: USER.id,
        details: { stage: "sign_in", otherSessionsClosed: true },
      });
    }
    expect(logTenantLogins).toHaveBeenCalledWith(supabase, USER.id);
    // Ningún registro lleva el código, su forma normalizada ni su huella.
    const everything = JSON.stringify([logAuditEvent.mock.calls, serverLog.mock.calls]);
    for (const secret of [BACKUP_CODE, NORMALIZED, HASH, "7KQM"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("si falla quitar el factor y el factor SIGUE puesto: se SUELTA el código, se avisa y no se completa ni se manda el aviso", async () => {
    removeAllFactors.mockRejectedValue(new Error("boom"));
    hasVerifiedFactor.mockResolvedValue(true);
    const state = await verify();
    expect(state).toEqual({ status: "error", message: UNFINISHED_MESSAGE });
    expect(hasVerifiedFactor).toHaveBeenCalledWith(USER.id);
    expect(releaseRecoveryCode).toHaveBeenCalledWith(CODE_ID);
    // Solo se alcanzó a cerrar las otras sesiones ANTES de quitar el factor (una vez).
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(completeRecoveryCode).not.toHaveBeenCalled();
    expect(sendRecoveryUsedNotice).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["session.mfa_failed"]);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        details: {
          reason: "recovery_remove_failed",
          stage: "sign_in",
          factorType: "recovery_code",
        },
      }),
    );
    // Quitar el factor falló: no cuenta como un código incorrecto.
    expect(recordSecondStepFailure).not.toHaveBeenCalled();
  });

  it("si no se puede saber si el factor sigue puesto, se trata como «sigue puesto»: se suelta el código", async () => {
    removeAllFactors.mockRejectedValue(new Error("boom"));
    hasVerifiedFactor.mockRejectedValue(new Error("boom"));
    expect(await verify()).toEqual({ status: "error", message: UNFINISHED_MESSAGE });
    expect(releaseRecoveryCode).toHaveBeenCalledWith(CODE_ID);
    expect(completeRecoveryCode).not.toHaveBeenCalled();
    expect(serverLog).toHaveBeenCalledWith("error", "mfa_recovery_factor_check_failed", {
      code: "unexpected",
    });
  });

  it("si `removeAllFactors` falla pero el factor SÍ se borró (la respuesta se perdió): sigue por el camino de éxito, sin soltar el código", async () => {
    removeAllFactors.mockRejectedValue(new Error("boom"));
    hasVerifiedFactor.mockResolvedValue(false);
    expect(await redirectedTo()).toBe("/cuenta/seguridad?aviso=respaldo");
    expect(releaseRecoveryCode).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(completeRecoveryCode).toHaveBeenCalledWith(CODE_ID);
    expect(sendRecoveryUsedNotice).toHaveBeenCalledWith(USER.email);
    expect(auditActions()).not.toContain("session.mfa_failed");
    expect(auditActions().filter((action) => action === "session.mfa_recovery_used")).toHaveLength(
      3,
    );
    expect(clearSecondStepFailures).toHaveBeenCalledWith(USER.id, "password");
  });

  it("si no se puede ni soltar el código, igual responde el mensaje (el código vence solo a los 2 minutos)", async () => {
    removeAllFactors.mockRejectedValue(new Error("boom"));
    releaseRecoveryCode.mockRejectedValue(new Error("boom"));
    expect(await verify()).toEqual({ status: "error", message: UNFINISHED_MESSAGE });
  });

  it("si la base falla al tomar el código: mensaje general, sin sumar fallo ni quitar nada", async () => {
    claimRecoveryCode.mockRejectedValue(new Error("boom"));
    expect(await verify()).toEqual({ status: "error", message: UNFINISHED_MESSAGE });
    expect(recordSecondStepFailure).not.toHaveBeenCalled();
    expect(removeAllFactors).not.toHaveBeenCalled();
  });

  it("si `complete` dice que el plazo venció, NO rompe: el factor ya se quitó, la persona ya quedó completa y entra", async () => {
    completeRecoveryCode.mockResolvedValue(null);
    expect(await redirectedTo()).toBe("/cuenta/seguridad?aviso=respaldo");
    // El aviso sale igual, al correo de la sesión (la base no entregó uno).
    expect(sendRecoveryUsedNotice).toHaveBeenCalledWith(USER.email);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "session.mfa_recovery_used" }),
    );
  });

  it("si cerrar las otras sesiones falla, se anota y se sigue (el factor ya no está): la auditoría lo dice", async () => {
    signOut.mockResolvedValue({ error: { code: "x", status: 500 } });
    expect(await redirectedTo()).toBe("/cuenta/seguridad?aviso=respaldo");
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.mfa_recovery_used",
        details: { stage: "sign_in", otherSessionsClosed: false, noticeSent: true },
      }),
    );
  });

  it("el aviso por correo es de MEJOR ESFUERZO: si no sale, igual entra (decisión D5 = A)", async () => {
    sendRecoveryUsedNotice.mockResolvedValue(false);
    expect(await redirectedTo()).toBe("/cuenta/seguridad?aviso=respaldo");
    // La auditoría deja constancia de que el aviso no salió.
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.mfa_recovery_used",
        details: { stage: "sign_in", otherSessionsClosed: true, noticeSent: false },
      }),
    );
  });

  it("si la sesión no trae correo, el aviso sale con el que lee la base al completar", async () => {
    requirePendingSecondStep.mockResolvedValue({ ...USER, email: undefined });
    expect(await redirectedTo()).toBe("/cuenta/seguridad?aviso=respaldo");
    expect(sendRecoveryUsedNotice).toHaveBeenCalledTimes(1);
    expect(sendRecoveryUsedNotice).toHaveBeenCalledWith("ana@ejemplo.test");
    expect(sendRecoveryUsedNotice.mock.invocationCallOrder[0]).toBeGreaterThan(
      completeRecoveryCode.mock.invocationCallOrder[0],
    );
  });

  it("por el enlace del correo: contadores «recovery», etapa «recovery» y lleva a elegir la contraseña nueva", async () => {
    hasRecoverySession.mockResolvedValue(true);
    expect(await redirectedTo()).toBe("/restablecer-contrasena");
    expect(beginSecondStepAttempt).toHaveBeenCalledWith(USER.id, "recovery");
    expect(clearSecondStepFailures).toHaveBeenCalledWith(USER.id, "recovery");
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.mfa_recovery_used",
        details: { stage: "recovery", otherSessionsClosed: true, noticeSent: true },
      }),
    );
  });

  it("no usa el código de la aplicación ni la contraseña: no pide contraseña ni consulta factores de Supabase", async () => {
    await redirectedTo();
    expect(confirmPassword).not.toHaveBeenCalled();
    expect(consumeTotpCode).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(listFactors).not.toHaveBeenCalled();
  });
});
