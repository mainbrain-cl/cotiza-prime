import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FormState } from "@/lib/auth/form-state";
import { RedirectSignal } from "@/test/supabase-mock";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ana@ejemplo.test",
  emailVerified: true,
};
const FACTOR_ID = "22222222-2222-4222-8222-222222222222";
const CODE_ID = "44444444-4444-4444-8444-444444444444";
const TENANT_A = "55555555-5555-4555-8555-555555555555";
const TENANT_B = "66666666-6666-4666-8666-666666666666";
const IP = "203.0.113.7";
const PASSWORD = "Contrasena-Muy-Secreta-9";
const APP_CODE = "123456";
const BACKUP_CODE = "7KQM-3XHP-W2RT";
const NORMALIZED = "7KQM3XHPW2RT";
const HASH = `hash(${USER.id}|${NORMALIZED})`;
const DONE_URL = "/cuenta/seguridad?aviso=desactivada";
const INVALID_MESSAGE =
  "Ese código de respaldo no sirve. Revisa cómo lo escribiste; cada código sirve una sola vez.";
const NOTICE_FAILED_MESSAGE =
  "No pudimos enviarte el correo de aviso, así que no desactivamos la verificación. Inténtalo de nuevo en unos minutos.";

const challengeAndVerify = vi.fn();
const listFactors = vi.fn();
const unenroll = vi.fn();
const signOut = vi.fn();
const supabase = { auth: { mfa: { challengeAndVerify, listFactors, unenroll }, signOut } };
const logAuditEvent = vi.fn();
const serverLog = vi.fn();
const requireUser = vi.fn();
const getSessionState = vi.fn();
const confirmPassword = vi.fn();
const isSecondStepIpLocked = vi.fn();
const beginSecondStepAttempt = vi.fn();
const releaseTotpCode = vi.fn();
const recordSecondStepFailure = vi.fn();
const clearSecondStepFailures = vi.fn();
const consumeTotpCode = vi.fn();
const activeTenantIdsOf = vi.fn();
const sendDisabledNotice = vi.fn();
const claimRecoveryCode = vi.fn();
const completeRecoveryCode = vi.fn();
const releaseRecoveryCode = vi.fn();
const revokeRecoveryCodes = vi.fn();

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
  getSessionState: () => getSessionState(),
}));
vi.mock("@/lib/auth/login-audit", () => ({
  activeTenantIdsOf: (...args: unknown[]) => activeTenantIdsOf(...args),
}));
// La huella usa la llave de la plataforma, que aquí no existe: se reemplaza por un texto que muestra de qué cuenta y código sale.
vi.mock("@/lib/auth/recovery-code", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/recovery-code")>()),
  recoveryCodeHash: (userId: string, normalized: string) => `hash(${userId}|${normalized})`,
}));
vi.mock("@/lib/auth/reauth", () => ({
  confirmPassword: (...args: unknown[]) => confirmPassword(...args),
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
  sendDisabledNotice: (...args: unknown[]) => sendDisabledNotice(...args),
}));
vi.mock("@/lib/security/mfa-recovery-gateway", () => ({
  MfaRecoveryGatewayError: class extends Error {
    code = "gateway";
  },
  claimRecoveryCode: (...args: unknown[]) => claimRecoveryCode(...args),
  completeRecoveryCode: (...args: unknown[]) => completeRecoveryCode(...args),
  releaseRecoveryCode: (...args: unknown[]) => releaseRecoveryCode(...args),
  revokeRecoveryCodes: (...args: unknown[]) => revokeRecoveryCodes(...args),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));

const { disableSecondStepAction } = await import("./second-step-manage-actions");

const IDLE = { status: "idle" } as const;
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const fields = (extra: Record<string, string> = {}) =>
  form({ code: APP_CODE, password: PASSWORD, ...extra });
const backupFields = (typed: string = BACKUP_CODE) => fields({ code: typed });
/** La acción vista como el estado de un formulario (errores); el éxito termina SIEMPRE en una redirección. */
const disable = async (data: FormData = fields()) =>
  (await disableSecondStepAction(IDLE, data)) as FormState;
const redirectedTo = async (data: FormData = fields()): Promise<string> => {
  try {
    await disableSecondStepAction(IDLE, data);
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
  throw new Error("la acción debía redirigir");
};
const untouched = (...mocks: { mock: { calls: unknown[] } }[]) => {
  for (const mock of mocks) expect(mock.mock.calls).toHaveLength(0);
};

beforeEach(() => {
  for (const mock of [
    challengeAndVerify,
    listFactors,
    unenroll,
    signOut,
    logAuditEvent,
    serverLog,
    requireUser,
    getSessionState,
    confirmPassword,
    isSecondStepIpLocked,
    beginSecondStepAttempt,
    releaseTotpCode,
    recordSecondStepFailure,
    clearSecondStepFailures,
    consumeTotpCode,
    activeTenantIdsOf,
    sendDisabledNotice,
    claimRecoveryCode,
    completeRecoveryCode,
    releaseRecoveryCode,
    revokeRecoveryCodes,
  ]) {
    mock.mockReset();
  }
  requireUser.mockResolvedValue(USER);
  getSessionState.mockResolvedValue({
    status: "complete",
    user: USER,
    secondStep: { active: true, since: "2026-11-10T00:00:00Z" },
  });
  confirmPassword.mockResolvedValue({ ok: true });
  isSecondStepIpLocked.mockResolvedValue(false);
  beginSecondStepAttempt.mockResolvedValue("none");
  consumeTotpCode.mockResolvedValue(true);
  recordSecondStepFailure.mockResolvedValue(undefined);
  clearSecondStepFailures.mockResolvedValue(undefined);
  listFactors.mockResolvedValue({
    data: { all: [{ id: FACTOR_ID, status: "verified", factor_type: "totp" }] },
    error: null,
  });
  challengeAndVerify.mockResolvedValue({ data: {}, error: null });
  unenroll.mockResolvedValue({ data: {}, error: null });
  signOut.mockResolvedValue({ error: null });
  activeTenantIdsOf.mockResolvedValue([TENANT_A, TENANT_B]);
  sendDisabledNotice.mockResolvedValue(true);
  claimRecoveryCode.mockResolvedValue({ codeId: CODE_ID, factorId: FACTOR_ID });
  completeRecoveryCode.mockResolvedValue({ email: USER.email });
  releaseRecoveryCode.mockResolvedValue(true);
  revokeRecoveryCodes.mockResolvedValue(10);
});

describe("disableSecondStepAction (desactivar la verificación en dos pasos)", () => {
  it("exige una sesión completa: sin ella la redirección la hace session.ts y no se consulta nada", async () => {
    requireUser.mockRejectedValue(new RedirectSignal("/ingresar/codigo"));
    await expect(disableSecondStepAction(IDLE, fields())).rejects.toBeInstanceOf(RedirectSignal);
    untouched(confirmPassword, listFactors, beginSecondStepAttempt, unenroll, sendDisabledNotice);
  });

  it("si la verificación ya no está activa (un doble envío) no hay nada que quitar: vuelve a la pantalla sin consultar ni avisar", async () => {
    getSessionState.mockResolvedValue({
      status: "complete",
      user: USER,
      secondStep: { active: false, since: null },
    });
    expect(await redirectedTo()).toBe("/cuenta/seguridad");
    untouched(confirmPassword, listFactors, unenroll, sendDisabledNotice, logAuditEvent);
  });

  it("si otra pestaña ya quitó el factor, se da por hecho: ni aviso, ni código gastado, ni auditoría", async () => {
    listFactors.mockResolvedValue({ data: { all: [] }, error: null });
    expect(await redirectedTo()).toBe("/cuenta/seguridad");
    untouched(
      beginSecondStepAttempt,
      challengeAndVerify,
      claimRecoveryCode,
      sendDisabledNotice,
      unenroll,
    );
  });

  it("sin poder leer los factores: mensaje de reintentar y no cambia nada", async () => {
    listFactors.mockResolvedValue({ data: null, error: { code: "x", status: 500 } });
    const state = await disable();
    expect(state.status).toBe("error");
    untouched(beginSecondStepAttempt, sendDisabledNotice, unenroll, revokeRecoveryCodes);
  });

  it("un código que no tiene la forma de ninguno de los dos, o sin contraseña, da error en su campo y no consulta nada", async () => {
    const badCode = await disable(fields({ code: "12" }));
    expect(badCode.fieldErrors?.code).toMatch(/6 números/);
    const empty = await disable(fields({ code: "  " }));
    expect(empty.fieldErrors?.code).toBeTruthy();
    const noPassword = await disable(fields({ password: "" }));
    expect(noPassword.fieldErrors?.password).toBeTruthy();
    untouched(confirmPassword, beginSecondStepAttempt, challengeAndVerify, claimRecoveryCode);
  });

  it("revisa la CONTRASEÑA primero (para «disable»): antes de los contadores, los factores, el código, el aviso y de quitar nada", async () => {
    await redirectedTo();
    expect(confirmPassword).toHaveBeenCalledWith(USER, PASSWORD, "disable");
    const passwordAt = confirmPassword.mock.invocationCallOrder[0];
    for (const later of [
      isSecondStepIpLocked,
      beginSecondStepAttempt,
      consumeTotpCode,
      listFactors,
      challengeAndVerify,
      sendDisabledNotice,
      unenroll,
    ]) {
      expect(passwordAt, later.getMockName()).toBeLessThan(later.mock.invocationCallOrder[0]);
    }
  });

  it("la contraseña incorrecta (con código de la aplicación o de respaldo): error en su campo y no se toca nada más", async () => {
    confirmPassword.mockResolvedValue({
      ok: false,
      reason: "wrong_password",
      message: "La contraseña no es correcta.",
    });
    for (const data of [fields(), backupFields()]) {
      expect(await disable(data)).toEqual({
        status: "error",
        fieldErrors: { password: "La contraseña no es correcta." },
      });
    }
    untouched(
      listFactors,
      beginSecondStepAttempt,
      consumeTotpCode,
      challengeAndVerify,
      claimRecoveryCode,
      sendDisabledNotice,
      unenroll,
      revokeRecoveryCodes,
      signOut,
      logAuditEvent,
    );
  });

  it("una contraseña bloqueada o sin poder comprobarse da un mensaje general y no cambia nada", async () => {
    confirmPassword.mockResolvedValue({ ok: false, reason: "locked", message: "Demasiados." });
    expect(await disable()).toEqual({ status: "error", message: "Demasiados." });
    untouched(beginSecondStepAttempt, claimRecoveryCode, sendDisabledNotice, unenroll);
  });

  describe("con el código de la aplicación", () => {
    it("usa los contadores «manage», lo verifica en UNA llamada con el factor verificado y lleva a la pantalla con el aviso", async () => {
      expect(await redirectedTo()).toBe(DONE_URL);
      expect(beginSecondStepAttempt).toHaveBeenCalledWith(USER.id, "manage");
      expect(consumeTotpCode).toHaveBeenCalledWith(USER.id, APP_CODE);
      expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: FACTOR_ID, code: APP_CODE });
      expect(clearSecondStepFailures).toHaveBeenCalledWith(USER.id, "manage");
      // No toca los códigos de respaldo para tomarlos ni completarlos: solo borra el juego.
      untouched(claimRecoveryCode, completeRecoveryCode, releaseRecoveryCode);
      expect(revokeRecoveryCodes).toHaveBeenCalledWith(USER.id);
    });

    it("acepta el código escrito con espacios o guiones, como lo muestra la aplicación", async () => {
      await redirectedTo(fields({ code: "123 456" }));
      expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: FACTOR_ID, code: APP_CODE });
    });

    it("el orden exacto: contraseña → código → aviso → quitar el factor → borrar códigos → cerrar otras sesiones → auditoría", async () => {
      await redirectedTo();
      const order = [
        confirmPassword,
        challengeAndVerify,
        sendDisabledNotice,
        unenroll,
        revokeRecoveryCodes,
        signOut,
        activeTenantIdsOf,
      ].map((mock) => mock.mock.invocationCallOrder[0]);
      expect(order.every((position) => position !== undefined)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(sendDisabledNotice).toHaveBeenCalledWith("ana@ejemplo.test");
      expect(unenroll).toHaveBeenCalledWith({ factorId: FACTOR_ID });
      expect(signOut).toHaveBeenCalledWith({ scope: "others" });
      // El aviso sale ANTES de quitar el factor, pero DESPUÉS de verificar el código (nadie dispara correos sin código).
      expect(sendDisabledNotice.mock.invocationCallOrder[0]).toBeLessThan(
        unenroll.mock.invocationCallOrder[0],
      );
    });

    it("deja `session.mfa_disabled` en la plataforma y en cada organización activa, con la forma de entrar", async () => {
      await redirectedTo();
      const disabled = logAuditEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.action === "session.mfa_disabled");
      expect(disabled).toHaveLength(3);
      expect(disabled.map((event) => event.tenantId)).toEqual([undefined, TENANT_A, TENANT_B]);
      for (const event of disabled) {
        expect(event).toMatchObject({
          result: "success",
          actorUserId: USER.id,
          details: { via: "totp", otherSessionsClosed: true },
        });
      }
      expect(activeTenantIdsOf).toHaveBeenCalledWith(supabase, USER.id);
    });

    it("un código ya usado se rechaza antes de verificar y no suma fallo ni avisa", async () => {
      consumeTotpCode.mockResolvedValue(false);
      const state = await disable();
      expect(state.message).toMatch(/ya se usó/);
      untouched(challengeAndVerify, recordSecondStepFailure, sendDisabledNotice, unenroll);
    });

    it("un código incorrecto suma un fallo a los contadores «manage», deja auditoría y no avisa ni quita nada", async () => {
      challengeAndVerify.mockResolvedValue({
        data: null,
        error: { code: "mfa_verification_failed", status: 422 },
      });
      const state = await disable();
      expect(state.message).toMatch(/El código no coincide/);
      expect(recordSecondStepFailure).toHaveBeenCalledWith(USER.id, "manage", IP);
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "session.mfa_failed",
          details: expect.objectContaining({ reason: "mfa_invalid_code", stage: "manage" }),
        }),
      );
      untouched(sendDisabledNotice, unenroll, revokeRecoveryCodes, signOut);
    });

    it("si Supabase falla por otra cosa, el código se libera, no suma fallo y no cambia nada", async () => {
      challengeAndVerify.mockResolvedValue({ data: null, error: { code: "x", status: 500 } });
      const state = await disable();
      expect(state.status).toBe("error");
      expect(releaseTotpCode).toHaveBeenCalledWith(USER.id, APP_CODE);
      untouched(recordSecondStepFailure, sendDisabledNotice, unenroll);
    });

    it("con el correo que no sale: NO se quita nada, no se borran los códigos ni se cierran sesiones, y se dice", async () => {
      sendDisabledNotice.mockResolvedValue(false);
      const state = await disable();
      expect(state).toEqual({ status: "error", message: NOTICE_FAILED_MESSAGE });
      untouched(unenroll, revokeRecoveryCodes, signOut, activeTenantIdsOf);
      expect(logAuditEvent).toHaveBeenCalledTimes(1);
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "session.mfa_failed",
          details: expect.objectContaining({ reason: "disable_notice_failed" }),
        }),
      );
    });

    it("una cuenta sin correo en la sesión es como un correo que no sale: no se desactiva", async () => {
      requireUser.mockResolvedValue({ ...USER, email: "" });
      const state = await disable();
      expect(state.message).toBe(NOTICE_FAILED_MESSAGE);
      untouched(sendDisabledNotice, unenroll);
    });
  });

  describe("con un código de respaldo", () => {
    it("toma la huella de la forma normalizada y de ESA cuenta, sin tocar el código de la aplicación", async () => {
      expect(await redirectedTo(backupFields("7kqm 3xhp-w2rt"))).toBe(DONE_URL);
      expect(claimRecoveryCode).toHaveBeenCalledWith(USER.id, HASH);
      expect(beginSecondStepAttempt).toHaveBeenCalledWith(USER.id, "manage");
      untouched(consumeTotpCode, challengeAndVerify);
      expect(clearSecondStepFailures).toHaveBeenCalledWith(USER.id, "manage");
    });

    it("el orden exacto: contraseña → tomar → aviso → quitar el factor → completar → borrar códigos → cerrar otras sesiones → auditoría", async () => {
      await redirectedTo(backupFields());
      const order = [
        confirmPassword,
        claimRecoveryCode,
        sendDisabledNotice,
        unenroll,
        completeRecoveryCode,
        revokeRecoveryCodes,
        signOut,
        activeTenantIdsOf,
      ].map((mock) => mock.mock.invocationCallOrder[0]);
      expect(order.every((position) => position !== undefined)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(completeRecoveryCode).toHaveBeenCalledWith(CODE_ID);
      // El código que se usó nunca se suelta.
      untouched(releaseRecoveryCode);
    });

    it("deja `session.mfa_disabled` con `via: recovery_code`", async () => {
      await redirectedTo(backupFields());
      const disabled = logAuditEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.action === "session.mfa_disabled");
      expect(disabled).toHaveLength(3);
      for (const event of disabled) expect(event.details.via).toBe("recovery_code");
    });

    it("un código que no sirve suma al contador «manage», deja auditoría y da UN solo mensaje, sin avisar ni quitar nada", async () => {
      claimRecoveryCode.mockResolvedValue(null);
      const state = await disable(backupFields());
      expect(state).toEqual({ status: "error", message: INVALID_MESSAGE });
      expect(recordSecondStepFailure).toHaveBeenCalledWith(USER.id, "manage", IP);
      expect(logAuditEvent).toHaveBeenCalledWith({
        action: "session.mfa_failed",
        result: "failure",
        actorUserId: USER.id,
        details: { reason: "recovery_invalid", stage: "manage", factorType: "recovery_code" },
      });
      untouched(sendDisabledNotice, unenroll, revokeRecoveryCodes, signOut, releaseRecoveryCode);
    });

    it("con el correo que no sale: se SUELTA el código (no se pierde), no se quita nada y se dice", async () => {
      sendDisabledNotice.mockResolvedValue(false);
      const state = await disable(backupFields());
      expect(state).toEqual({ status: "error", message: NOTICE_FAILED_MESSAGE });
      expect(releaseRecoveryCode).toHaveBeenCalledWith(CODE_ID);
      untouched(unenroll, completeRecoveryCode, revokeRecoveryCodes, signOut);
    });

    it("si falla quitar el factor: se SUELTA el código, no se borran los códigos ni se cierran sesiones", async () => {
      unenroll.mockResolvedValue({ data: null, error: { code: "x", status: 500 } });
      const state = await disable(backupFields());
      expect(state.status).toBe("error");
      expect(state.message).toMatch(/No pudimos desactivar/);
      expect(releaseRecoveryCode).toHaveBeenCalledWith(CODE_ID);
      untouched(completeRecoveryCode, revokeRecoveryCodes, signOut);
    });

    it("si no se puede ni soltar el código, igual responde el mensaje (el código vence solo a los 2 minutos)", async () => {
      sendDisabledNotice.mockResolvedValue(false);
      releaseRecoveryCode.mockRejectedValue(new Error("boom"));
      const state = await disable(backupFields());
      expect(state.message).toBe(NOTICE_FAILED_MESSAGE);
      expect(serverLog).toHaveBeenCalledWith("error", "mfa_recovery_release_failed", {
        code: "unexpected",
      });
    });

    it("si la base falla al tomar el código: mensaje general, sin sumar fallo ni avisar ni quitar nada", async () => {
      claimRecoveryCode.mockRejectedValue(new Error("boom"));
      const state = await disable(backupFields());
      expect(state.message).toMatch(/No pudimos desactivar/);
      untouched(recordSecondStepFailure, sendDisabledNotice, unenroll);
    });

    it("si `complete` dice que el plazo venció, NO rompe: el factor ya se quitó y los códigos se borran igual", async () => {
      completeRecoveryCode.mockResolvedValue(null);
      expect(await redirectedTo(backupFields())).toBe(DONE_URL);
      expect(revokeRecoveryCodes).toHaveBeenCalledWith(USER.id);
    });

    it("si `complete` falla, se anota y se sigue", async () => {
      completeRecoveryCode.mockRejectedValue(new Error("boom"));
      expect(await redirectedTo(backupFields())).toBe(DONE_URL);
      expect(serverLog).toHaveBeenCalledWith("error", "mfa_recovery_complete_failed", {
        code: "unexpected",
      });
    });
  });

  describe("el bloqueo por intentos", () => {
    it("cuenta o IP bloqueada con el código de la aplicación: no llama a Supabase ni avisa", async () => {
      beginSecondStepAttempt.mockResolvedValue("short");
      const state = await disable();
      expect(state.message).toMatch(/Demasiados intentos/);
      untouched(challengeAndVerify, sendDisabledNotice, unenroll);
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "session.mfa_locked", result: "denied" }),
      );
    });

    it("cuenta o IP bloqueada con un código de respaldo: no se consulta la base de códigos", async () => {
      isSecondStepIpLocked.mockResolvedValue(true);
      const state = await disable(backupFields());
      expect(state.message).toMatch(/Demasiados intentos/);
      untouched(beginSecondStepAttempt, claimRecoveryCode, sendDisabledNotice, unenroll);
    });

    it("el bloqueo de 24 h del camino «manage» tiene su propio mensaje (esperar y, si no fuiste tú, cambiar la contraseña)", async () => {
      beginSecondStepAttempt.mockResolvedValue("day");
      for (const data of [fields(), backupFields()]) {
        const message = (await disable(data)).message ?? "";
        expect(message).toMatch(/Si no fuiste tú, cambia tu contraseña/);
        expect(message).not.toMatch(/¿Olvidaste tu contraseña\?/);
      }
    });

    it("los dos tipos de código comparten la ventana: cinco intentos mezclados y el sexto queda bloqueado", async () => {
      let used = 0;
      beginSecondStepAttempt.mockImplementation(async () => {
        used += 1;
        return used > 5 ? "short" : "none";
      });
      claimRecoveryCode.mockResolvedValue(null);
      challengeAndVerify.mockResolvedValue({
        data: null,
        error: { code: "mfa_verification_failed", status: 422 },
      });
      const attempts = [
        fields(),
        backupFields(),
        fields({ code: "654321" }),
        backupFields("AAAA-BBBB-CCCC"),
        fields({ code: "111111" }),
      ];
      for (const data of attempts) expect((await disable(data)).message).not.toMatch(/Demasiados/);
      expect((await disable(backupFields())).message).toMatch(/Demasiados/);
      // El sexto no llegó ni a consultar la base de códigos.
      expect(claimRecoveryCode).toHaveBeenCalledTimes(2);
    });
  });

  describe("quitar el factor y lo que viene después", () => {
    it("lo quita con la PROPIA sesión (el cliente con las cookies de la persona), nunca con otra cosa", async () => {
      await redirectedTo();
      expect(unenroll).toHaveBeenCalledTimes(1);
      expect(unenroll).toHaveBeenCalledWith({ factorId: FACTOR_ID });
    });

    it("un factor que ya no existe (doble envío) se da por hecho y se sigue hasta el final", async () => {
      unenroll.mockResolvedValue({
        data: null,
        error: { code: "mfa_factor_not_found", status: 404 },
      });
      expect(await redirectedTo()).toBe(DONE_URL);
      expect(revokeRecoveryCodes).toHaveBeenCalled();
      expect(signOut).toHaveBeenCalled();
    });

    it("si falla quitar el factor con el código de la aplicación: error, sin borrar códigos ni cerrar sesiones ni dejar `mfa_disabled`", async () => {
      unenroll.mockResolvedValue({ data: null, error: { code: "x", status: 500 } });
      const state = await disable();
      expect(state.message).toMatch(/No pudimos desactivar/);
      untouched(revokeRecoveryCodes, signOut, activeTenantIdsOf);
      expect(logAuditEvent.mock.calls.map(([event]) => event.action)).not.toContain(
        "session.mfa_disabled",
      );
    });

    it("si borrar los códigos falla, se anota y se sigue: sin factor no sirven de todos modos", async () => {
      revokeRecoveryCodes.mockRejectedValue(new Error("boom"));
      expect(await redirectedTo()).toBe(DONE_URL);
      expect(serverLog).toHaveBeenCalledWith("error", "mfa_recovery_revoke_failed", {
        code: "unexpected",
      });
    });

    it("si cerrar las otras sesiones falla, se anota, se sigue y la auditoría lo dice", async () => {
      signOut.mockResolvedValue({ error: { code: "x", status: 500 } });
      expect(await redirectedTo()).toBe(DONE_URL);
      const disabled = logAuditEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.action === "session.mfa_disabled");
      for (const event of disabled) expect(event.details.otherSessionsClosed).toBe(false);
    });

    it("no toca los enlaces de anulación de H-118: ni la tabla ni la pasarela de factores", async () => {
      // Las únicas dependencias de la base son la pasarela de códigos (mockeada arriba) y el cliente con la sesión; ninguna lee tablas.
      await redirectedTo();
      expect(Object.keys(supabase)).toEqual(["auth"]);
    });
  });

  it("ni la contraseña ni el código (ni su forma normalizada ni su huella) llegan a la auditoría ni al registro, en ningún camino", async () => {
    await redirectedTo(fields());
    await redirectedTo(backupFields());
    claimRecoveryCode.mockResolvedValue(null);
    await disable(backupFields());
    sendDisabledNotice.mockResolvedValue(false);
    await disable(fields());
    const everything = JSON.stringify([logAuditEvent.mock.calls, serverLog.mock.calls]);
    for (const secret of [PASSWORD, APP_CODE, BACKUP_CODE, NORMALIZED, HASH, "7KQM"]) {
      expect(everything).not.toContain(secret);
    }
  });
});
