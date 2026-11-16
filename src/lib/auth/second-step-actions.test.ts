import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FormState } from "@/lib/auth/form-state";
import { RedirectSignal } from "@/test/supabase-mock";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ana@ejemplo.test",
  emailVerified: true,
};
const FACTOR_ID = "22222222-2222-4222-8222-222222222222";
const IP = "203.0.113.7";
/** El juego de códigos de respaldo que crea la activación (ya formateados). */
const CODES_ISSUED = {
  ok: true,
  recoveryCodes: ["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"],
  setId: "33333333-3333-4333-8333-333333333333",
};
/** El aviso de la activación salió. */
const NOTICE_SENT = { sentFactorIds: [FACTOR_ID], sentTo: USER.email, failures: [] };

const challengeAndVerify = vi.fn();
const listFactors = vi.fn();
const unenroll = vi.fn();
const enroll = vi.fn();
const tableReads = vi.fn();
const rpcCalls = vi.fn();
const requireActiveTenant = vi.fn();
const requirePermission = vi.fn();
const supabase = {
  auth: { mfa: { challengeAndVerify, listFactors, unenroll, enroll } },
  from: tableReads,
  rpc: rpcCalls,
};
const logAuditEvent = vi.fn();
const serverLog = vi.fn();
const getSessionState = vi.fn();
const requirePendingSecondStep = vi.fn();
const requireUser = vi.fn();
const hasRecoverySession = vi.fn();
const hasPendingInvitation = vi.fn();
const logTenantLogins = vi.fn();
const activeTenantIdsOf = vi.fn();
const isSecondStepIpLocked = vi.fn();
const beginSecondStepAttempt = vi.fn();
const releaseTotpCode = vi.fn();
const recordSecondStepFailure = vi.fn();
const clearSecondStepFailures = vi.fn();
const consumeTotpCode = vi.fn();
const grantEnrollmentPermit = vi.fn();
const revertEnrollmentAlert = vi.fn();
const deliverPendingEnrollmentNotices = vi.fn();
const revertEnrollment = vi.fn();
const confirmPassword = vi.fn();
const issueRecoveryCodes = vi.fn();

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
  getSessionState: () => getSessionState(),
  requirePendingSecondStep: () => requirePendingSecondStep(),
  requireUser: () => requireUser(),
  hasRecoverySession: () => hasRecoverySession(),
}));
vi.mock("@/lib/auth/reauth", () => ({
  confirmPassword: (...args: unknown[]) => confirmPassword(...args),
}));
vi.mock("@/lib/auth/recovery-code-issue", () => ({
  issueRecoveryCodes: (...args: unknown[]) => issueRecoveryCodes(...args),
}));
vi.mock("@/lib/auth/login-audit", () => ({
  logTenantLogins: (...args: unknown[]) => logTenantLogins(...args),
  activeTenantIdsOf: (...args: unknown[]) => activeTenantIdsOf(...args),
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
vi.mock("@/lib/security/mfa-alerts-gateway", () => ({
  MfaAlertsGatewayError: class extends Error {
    code = "gateway";
  },
  grantEnrollmentPermit: (...args: unknown[]) => grantEnrollmentPermit(...args),
  revertEnrollmentAlert: (...args: unknown[]) => revertEnrollmentAlert(...args),
}));
vi.mock("@/lib/security/mfa-enrollment-notice", () => ({
  deliverPendingEnrollmentNotices: (...args: unknown[]) => deliverPendingEnrollmentNotices(...args),
  revertEnrollment: (...args: unknown[]) => revertEnrollment(...args),
  failureCodeFor: (
    delivery: { failures: { factorId: string | null; code: string }[] },
    factorId: string,
  ) =>
    delivery.failures.find((failure) => failure.factorId === factorId)?.code ??
    delivery.failures[0]?.code ??
    "not_sent",
}));
vi.mock("@/lib/tenant/active-tenant", () => ({
  requireActiveTenant: (...args: unknown[]) => requireActiveTenant(...args),
}));
vi.mock("@/lib/permissions/require", () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));
vi.mock("@/lib/team/invitation-cookie", () => ({
  hasPendingInvitation: () => hasPendingInvitation(),
}));

const {
  cancelTotpEnrollmentAction,
  confirmTotpEnrollmentAction,
  startTotpEnrollmentAction,
  verifySecondStepAction,
} = await import("./second-step-actions");

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const IDLE = { status: "idle" } as const;
/** La acción de confirmar la activación, vista como el estado de un formulario (errores); el éxito se prueba aparte. */
const confirmForm = async (data: FormData) =>
  (await confirmTotpEnrollmentAction(IDLE, data)) as FormState;
const PENDING_STATE = { status: "second_step_pending", user: USER, factorId: FACTOR_ID };
const COMPLETE_STATE = {
  status: "complete",
  user: USER,
  secondStep: { active: false, since: null },
};

async function redirectOf(run: () => Promise<unknown>): Promise<string | { returned: unknown }> {
  try {
    return { returned: await run() };
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
}

beforeEach(() => {
  for (const mock of [
    challengeAndVerify,
    listFactors,
    unenroll,
    enroll,
    logAuditEvent,
    serverLog,
    getSessionState,
    requirePendingSecondStep,
    requireUser,
    hasRecoverySession,
    hasPendingInvitation,
    logTenantLogins,
    activeTenantIdsOf,
    isSecondStepIpLocked,
    beginSecondStepAttempt,
    releaseTotpCode,
    tableReads,
    rpcCalls,
    requireActiveTenant,
    requirePermission,
    recordSecondStepFailure,
    clearSecondStepFailures,
    consumeTotpCode,
    grantEnrollmentPermit,
    revertEnrollmentAlert,
    deliverPendingEnrollmentNotices,
    revertEnrollment,
    confirmPassword,
    issueRecoveryCodes,
  ]) {
    mock.mockReset();
  }
  getSessionState.mockResolvedValue(PENDING_STATE);
  requirePendingSecondStep.mockResolvedValue(USER);
  requireUser.mockResolvedValue(USER);
  hasRecoverySession.mockResolvedValue(false);
  hasPendingInvitation.mockResolvedValue(false);
  isSecondStepIpLocked.mockResolvedValue(false);
  beginSecondStepAttempt.mockResolvedValue("none");
  recordSecondStepFailure.mockResolvedValue(undefined);
  consumeTotpCode.mockResolvedValue(true);
  challengeAndVerify.mockResolvedValue({ data: {}, error: null });
  activeTenantIdsOf.mockResolvedValue([]);
  grantEnrollmentPermit.mockResolvedValue(true);
  revertEnrollmentAlert.mockResolvedValue("closed");
  revertEnrollment.mockResolvedValue(true);
  deliverPendingEnrollmentNotices.mockResolvedValue(NOTICE_SENT);
  confirmPassword.mockResolvedValue({ ok: true });
  issueRecoveryCodes.mockResolvedValue(CODES_ISSUED);
});

const auditActions = () => logAuditEvent.mock.calls.map(([event]) => event.action);

const WRONG = { error: { code: "mfa_verification_failed", status: 422 } };

describe("verifySecondStepAction (código tras la contraseña)", () => {
  it("exige una sesión parcial: sin sesión o con sesión completa la redirección la hace session.ts y no se consulta nada", async () => {
    requirePendingSecondStep.mockRejectedValue(new RedirectSignal("/"));
    expect(await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "123456" })))).toBe(
      "/",
    );
    expect(beginSecondStepAttempt).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it.each(["12345", "1234567", "12345a", "", "abcdef"])(
    "un código mal escrito (%j) da error en el campo y no consulta límites ni a Supabase",
    async (code) => {
      const state = await verifySecondStepAction(IDLE, form({ code }));
      expect(state.status).toBe("error");
      expect(state.fieldErrors?.code).toBeTruthy();
      expect(beginSecondStepAttempt).not.toHaveBeenCalled();
      expect(consumeTotpCode).not.toHaveBeenCalled();
      expect(challengeAndVerify).not.toHaveBeenCalled();
    },
  );

  it("bloqueo corto (15 min) de la cuenta: «demasiados intentos» y NO llama a Supabase ni gasta el código", async () => {
    beginSecondStepAttempt.mockResolvedValue("short");
    const state = await verifySecondStepAction(IDLE, form({ code: "123456" }));
    expect(state.message).toMatch(/Espera unos minutos/);
    expect(consumeTotpCode).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["session.mfa_locked"]);
  });

  it("bloqueo del día (24 h) con la contraseña: orienta a recuperarla («¿Olvidaste tu contraseña?»), no a esperar unos minutos", async () => {
    beginSecondStepAttempt.mockResolvedValue("day");
    const state = await verifySecondStepAction(IDLE, form({ code: "123456" }));
    expect(state.message).toBe(
      "Demasiados intentos. Si no fuiste tú, alguien puede tener tu contraseña: usa «¿Olvidaste tu contraseña?» para entrar con un enlace a tu correo y cámbiala.",
    );
    expect(state.message).not.toMatch(/unos minutos/);
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("bloqueo del día (24 h) por el enlace del correo: sin la sugerencia de la contraseña, dice «hoy» y «mañana»", async () => {
    hasRecoverySession.mockResolvedValue(true);
    beginSecondStepAttempt.mockResolvedValue("day");
    const state = await verifySecondStepAction(IDLE, form({ code: "123456" }));
    expect(state.message).toMatch(/Demasiados intentos hoy\. Vuelve a intentarlo mañana/);
    expect(state.message).not.toMatch(/contraseña|unos minutos/);
  });

  it("IP bloqueada: mismo rechazo y no se registra un intento de la cuenta", async () => {
    isSecondStepIpLocked.mockResolvedValue(true);
    const state = await verifySecondStepAction(IDLE, form({ code: "123456" }));
    expect(state.message).toMatch(/Demasiados intentos/);
    expect(beginSecondStepAttempt).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("el intento se REGISTRA antes de llamar a Supabase, y la IP se revisa antes", async () => {
    const order: string[] = [];
    isSecondStepIpLocked.mockImplementation(async () => (order.push("ip"), false));
    beginSecondStepAttempt.mockImplementation(async () => (order.push("intento"), "none"));
    consumeTotpCode.mockImplementation(async () => (order.push("codigo"), true));
    challengeAndVerify.mockImplementation(async () => (order.push("supabase"), { error: null }));
    await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "123456" })));
    expect(order).toEqual(["ip", "intento", "codigo", "supabase"]);
    expect(isSecondStepIpLocked).toHaveBeenCalledWith(IP);
    expect(beginSecondStepAttempt).toHaveBeenCalledWith(USER.id, "password");
  });

  it("envíos en paralelo: solo los que la base deja pasar llegan a Supabase (5 de 12)", async () => {
    let seen = 0;
    beginSecondStepAttempt.mockImplementation(async () => (++seen > 5 ? "short" : "none"));
    challengeAndVerify.mockResolvedValue(WRONG);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => verifySecondStepAction(IDLE, form({ code: "123456" }))),
    );
    expect(challengeAndVerify.mock.calls.length).toBeLessThanOrEqual(5);
    expect(results.filter((r) => /Espera unos minutos/.test(r.message ?? ""))).toHaveLength(7);
  });

  it("el camino de recuperación usa OTROS contadores que el ingreso con contraseña", async () => {
    await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "123456" })));
    expect(beginSecondStepAttempt).toHaveBeenLastCalledWith(USER.id, "password");
    expect(clearSecondStepFailures).toHaveBeenLastCalledWith(USER.id, "password");
    hasRecoverySession.mockResolvedValue(true);
    challengeAndVerify.mockResolvedValueOnce(WRONG);
    await verifySecondStepAction(IDLE, form({ code: "654321" }));
    expect(beginSecondStepAttempt).toHaveBeenLastCalledWith(USER.id, "recovery");
    expect(recordSecondStepFailure).toHaveBeenLastCalledWith(USER.id, "recovery", IP);
    await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "246801" })));
    expect(clearSecondStepFailures).toHaveBeenLastCalledWith(USER.id, "recovery");
  });

  it("un código ya usado se avisa, NO suma al tope del día ni al de la IP (no es un código incorrecto) y NO se llama a Supabase", async () => {
    consumeTotpCode.mockResolvedValue(false);
    const state = await verifySecondStepAction(IDLE, form({ code: "123456" }));
    expect(state.message).toBe("Ese código ya se usó. Espera el siguiente.");
    expect(recordSecondStepFailure).not.toHaveBeenCalled();
    // El intento sí contó en la ventana de 15 minutos (se registra antes de revisar el código).
    expect(beginSecondStepAttempt).toHaveBeenCalledTimes(1);
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.mfa_failed",
        details: { reason: "code_reused", stage: "sign_in", factorType: "totp" },
      }),
    );
  });

  it("un código incorrecto suma al tope del día y de la IP, deja auditoría y no muestra el código", async () => {
    challengeAndVerify.mockResolvedValue(WRONG);
    const state = await verifySecondStepAction(IDLE, form({ code: "654321" }));
    expect(state.status).toBe("error");
    expect(state.message).toMatch(/El código no coincide/);
    expect(JSON.stringify(state)).not.toContain("654321");
    expect(recordSecondStepFailure).toHaveBeenCalledWith(USER.id, "password", IP);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.mfa_failed",
        result: "failure",
        actorUserId: USER.id,
      }),
    );
    expect(clearSecondStepFailures).not.toHaveBeenCalled();
    // El código SÍ se gastó (Supabase lo juzgó): no se libera.
    expect(releaseTotpCode).not.toHaveBeenCalled();
  });

  it("el 429 de Supabase libera el código y NO suma al tope del día ni al de la IP (el intento ya contó en la ventana)", async () => {
    challengeAndVerify.mockResolvedValue({
      error: { code: "over_request_rate_limit", status: 429 },
    });
    const state = await verifySecondStepAction(IDLE, form({ code: "123456" }));
    expect(state.message).toMatch(/Demasiados intentos/);
    expect(releaseTotpCode).toHaveBeenCalledWith(USER.id, "123456");
    expect(recordSecondStepFailure).not.toHaveBeenCalled();
    // El intento de la ventana de 15 minutos se registró antes de hablar con Supabase.
    expect(beginSecondStepAttempt).toHaveBeenCalledTimes(1);
  });

  it("si Supabase falla por otra cosa (IP distinta, sesión), el código NO se gastó: se libera, no suma fallo y el mensaje es el de ingresar de nuevo", async () => {
    for (const code of [
      "mfa_ip_address_mismatch",
      "mfa_challenge_expired",
      "mfa_factor_not_found",
      "algo_raro",
    ]) {
      releaseTotpCode.mockClear();
      recordSecondStepFailure.mockClear();
      challengeAndVerify.mockResolvedValue({ error: { code, status: 422 } });
      const state = await verifySecondStepAction(IDLE, form({ code: "123456" }));
      expect(state.message, code).toBe(
        "No pudimos verificar el código. Cierra sesión y vuelve a ingresar.",
      );
      expect(state.message, code).not.toMatch(/activación caducó/);
      expect(releaseTotpCode, code).toHaveBeenCalledWith(USER.id, "123456");
      expect(recordSecondStepFailure, code).not.toHaveBeenCalled();
    }
  });

  it("sin factor de aplicación verificado no se llama a Supabase y el código se libera", async () => {
    getSessionState.mockResolvedValue({ ...PENDING_STATE, factorId: null });
    const state = await verifySecondStepAction(IDLE, form({ code: "123456" }));
    expect(state.status).toBe("error");
    expect(state.message).toMatch(/Cierra sesión y vuelve a ingresar/);
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(releaseTotpCode).toHaveBeenCalledWith(USER.id, "123456");
  });

  it("desafío y verificación van en UNA sola llamada con el factor y el código", async () => {
    await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "123 456" })));
    expect(challengeAndVerify).toHaveBeenCalledTimes(1);
    expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: FACTOR_ID, code: "123456" });
  });

  it("éxito: limpia los intentos, audita, escribe el ingreso por organización con el MISMO cliente y va al inicio", async () => {
    const target = await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "123456" })));
    expect(target).toBe("/");
    expect(clearSecondStepFailures).toHaveBeenCalledWith(USER.id, "password");
    expect(logAuditEvent).toHaveBeenCalledWith({
      action: "session.mfa_verified",
      result: "success",
      actorUserId: USER.id,
      details: { stage: "sign_in", factorType: "totp" },
    });
    expect(logTenantLogins).toHaveBeenCalledWith(supabase, USER.id);
  });

  it("tras ingresar con el código reintenta los avisos de activación pendientes; si el código es incorrecto, no", async () => {
    challengeAndVerify.mockResolvedValue(WRONG);
    await verifySecondStepAction(IDLE, form({ code: "987654" }));
    expect(deliverPendingEnrollmentNotices).not.toHaveBeenCalled();
    challengeAndVerify.mockResolvedValue({ error: null });
    await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "246801" })));
    expect(deliverPendingEnrollmentNotices).toHaveBeenCalledWith(USER.id);
    // Quien ingresa con su código ya tiene el segundo paso: un aviso que no salga no revierte nada.
    expect(revertEnrollment).not.toHaveBeenCalled();
  });

  it("éxito viniendo de una invitación va a unirse; viniendo del enlace de recuperar la contraseña, a elegir la nueva", async () => {
    hasPendingInvitation.mockResolvedValue(true);
    expect(await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "123456" })))).toBe(
      "/invitacion",
    );
    hasRecoverySession.mockResolvedValue(true);
    expect(await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "123456" })))).toBe(
      "/restablecer-contrasena",
    );
  });

  it("la auditoría y el registro nunca llevan el código, la clave ni el uri", async () => {
    challengeAndVerify.mockResolvedValue(WRONG);
    await verifySecondStepAction(IDLE, form({ code: "987654" }));
    challengeAndVerify.mockResolvedValue({ error: null });
    await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "246801" })));
    const everything = JSON.stringify([...logAuditEvent.mock.calls, ...serverLog.mock.calls]);
    expect(everything).not.toMatch(/987654|246801|otpauth|secret/);
    for (const [, , fields] of serverLog.mock.calls) {
      expect(Object.keys(fields ?? {}).sort()).toEqual(["code", "stage"]);
    }
  });

  it("no consulta rol ni organización activa ni lee tablas: es de la cuenta", async () => {
    await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "123456" })));
    expect(challengeAndVerify).toHaveBeenCalled();
    expect(requireActiveTenant).not.toHaveBeenCalled();
    expect(requirePermission).not.toHaveBeenCalled();
    expect(tableReads).not.toHaveBeenCalled();
    expect(rpcCalls).not.toHaveBeenCalled();
  });
});

describe("startTotpEnrollmentAction (activar, paso 1)", () => {
  const ENROLLED = {
    data: {
      id: FACTOR_ID,
      totp: {
        qr_code: 'data:image/svg+xml;utf-8,<svg width="10"><rect fill="#000"/></svg>',
        secret: "ABCDEFGHIJKLMNOP",
        uri: "otpauth://totp/Cotiza%20Prime:ana@ejemplo.test?secret=ABCDEFGHIJKLMNOP",
      },
    },
    error: null,
  };

  beforeEach(() => {
    getSessionState.mockResolvedValue(COMPLETE_STATE);
    listFactors.mockResolvedValue({ data: { all: [] }, error: null });
    unenroll.mockResolvedValue({ data: {}, error: null });
    enroll.mockResolvedValue(ENROLLED);
  });

  it("si ya hay un factor verificado responde «ya está activa» y no llama a enroll", async () => {
    getSessionState.mockResolvedValue({
      ...COMPLETE_STATE,
      secondStep: { active: true, since: "2026-11-02T10:00:00Z" },
    });
    expect(await startTotpEnrollmentAction()).toEqual({ status: "already_active" });
    listFactors.mockResolvedValue({
      data: { all: [{ id: "f", status: "verified", factor_type: "totp" }] },
      error: null,
    });
    getSessionState.mockResolvedValue(COMPLETE_STATE);
    expect(await startTotpEnrollmentAction()).toEqual({ status: "already_active" });
    expect(enroll).not.toHaveBeenCalled();
  });

  it("quita los intentos sin verificar y luego activa con el nombre Cotiza Prime, sin nombre propio", async () => {
    listFactors.mockResolvedValue({
      data: {
        all: [
          { id: "viejo-1", status: "unverified", factor_type: "totp" },
          { id: "viejo-2", status: "unverified", factor_type: "totp" },
        ],
      },
      error: null,
    });
    const result = await startTotpEnrollmentAction();
    expect(unenroll.mock.calls.map(([args]) => args.factorId)).toEqual(["viejo-1", "viejo-2"]);
    expect(enroll).toHaveBeenCalledWith({
      factorType: "totp",
      issuer: "Cotiza Prime",
      friendlyName: "Aplicación de códigos",
    });
    expect(unenroll.mock.invocationCallOrder[1]).toBeLessThan(enroll.mock.invocationCallOrder[0]);
    expect(result.status).toBe("started");
  });

  it("entrega la clave y el QR como imagen (data URL codificada), nunca como HTML", async () => {
    const result = await startTotpEnrollmentAction();
    if (result.status !== "started") throw new Error("se esperaba started");
    expect(result.enrollment).toMatchObject({
      factorId: FACTOR_ID,
      secret: "ABCDEFGHIJKLMNOP",
    });
    expect(result.enrollment.qrCode.startsWith("data:image/svg+xml;charset=utf-8,%3Csvg")).toBe(
      true,
    );
    expect(decodeURIComponent(result.enrollment.qrCode.split(",")[1])).toContain('fill="#000"');
  });

  it("si no se puede quitar un intento anterior o activar, avisa sin detalles y registra solo el código del error", async () => {
    listFactors.mockResolvedValue({
      data: { all: [{ id: "viejo", status: "unverified", factor_type: "totp" }] },
      error: null,
    });
    unenroll.mockResolvedValue({ data: null, error: { code: "unexpected_failure" } });
    expect((await startTotpEnrollmentAction()).status).toBe("error");
    expect(enroll).not.toHaveBeenCalled();
    unenroll.mockResolvedValue({ data: {}, error: null });
    enroll.mockResolvedValue({ data: null, error: { code: "mfa_factor_name_conflict" } });
    expect((await startTotpEnrollmentAction()).status).toBe("error");
    for (const [, , fields] of serverLog.mock.calls) expect(Object.keys(fields)).toEqual(["code"]);
  });

  it("no mira rol ni organización: solo exige una sesión completa, y no lee tablas", async () => {
    await startTotpEnrollmentAction();
    expect(requireUser).toHaveBeenCalledTimes(1);
    expect(requireActiveTenant).not.toHaveBeenCalled();
    expect(requirePermission).not.toHaveBeenCalled();
    expect(tableReads).not.toHaveBeenCalled();
    expect(rpcCalls).not.toHaveBeenCalled();
  });
});

describe("confirmTotpEnrollmentAction (activar, paso 2)", () => {
  beforeEach(() => {
    listFactors.mockResolvedValue({
      data: { all: [{ id: FACTOR_ID, status: "unverified", factor_type: "totp" }] },
      error: null,
    });
    activeTenantIdsOf.mockResolvedValue(["t1", "t2"]);
  });
  const PASSWORD = "Contrasena-Muy-Secreta-9";
  const fields = (extra: Record<string, string> = {}) =>
    form({ factorId: FACTOR_ID, code: "123456", password: PASSWORD, ...extra });

  it("un código mal escrito no consulta nada (ni siquiera la contraseña)", async () => {
    const state = await confirmForm(fields({ code: "12" }));
    expect(state.fieldErrors?.code).toBeTruthy();
    expect(confirmPassword).not.toHaveBeenCalled();
    expect(listFactors).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("sin contraseña (o más larga de lo posible) da error en el campo y no consulta nada", async () => {
    for (const password of ["", "x".repeat(73)]) {
      const state = await confirmForm(fields({ password }));
      expect(state.status).toBe("error");
      expect(state.fieldErrors?.password).toBeTruthy();
      expect(state.fieldErrors?.code).toBeUndefined();
    }
    const data = new FormData();
    data.set("factorId", FACTOR_ID);
    data.set("code", "123456");
    expect((await confirmForm(data)).fieldErrors?.password).toBeTruthy();
    expect(confirmPassword).not.toHaveBeenCalled();
    expect(beginSecondStepAttempt).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("código y contraseña mal escritos a la vez: los dos errores en sus campos", async () => {
    const state = await confirmForm(fields({ code: "12", password: "" }));
    expect(state.fieldErrors?.code).toBeTruthy();
    expect(state.fieldErrors?.password).toBeTruthy();
  });

  it("la contraseña se pide a nombre de la persona de la sesión, para «enroll», ANTES de tocar contadores, el código ya usado, el permiso o Supabase", async () => {
    await redirectOf(() => confirmTotpEnrollmentAction(IDLE, fields()));
    expect(confirmPassword).toHaveBeenCalledWith(USER, PASSWORD, "enroll");
    const passwordAt = confirmPassword.mock.invocationCallOrder[0];
    for (const later of [
      isSecondStepIpLocked,
      beginSecondStepAttempt,
      consumeTotpCode,
      listFactors,
      grantEnrollmentPermit,
      challengeAndVerify,
    ]) {
      expect(passwordAt, later.getMockName()).toBeLessThan(later.mock.invocationCallOrder[0]);
    }
  });

  it("contraseña incorrecta: error en el campo de la contraseña; no se gasta el código, no se tocan los contadores y no se da el permiso", async () => {
    confirmPassword.mockResolvedValue({
      ok: false,
      reason: "wrong_password",
      message: "La contraseña no es correcta.",
    });
    const state = await confirmForm(fields());
    expect(state).toEqual({
      status: "error",
      fieldErrors: { password: "La contraseña no es correcta." },
    });
    expect(JSON.stringify(state)).not.toContain(PASSWORD);
    for (const untouched of [
      isSecondStepIpLocked,
      beginSecondStepAttempt,
      consumeTotpCode,
      releaseTotpCode,
      recordSecondStepFailure,
      clearSecondStepFailures,
      listFactors,
      grantEnrollmentPermit,
      challengeAndVerify,
      deliverPendingEnrollmentNotices,
      logAuditEvent,
    ]) {
      expect(untouched).not.toHaveBeenCalled();
    }
  });

  it.each(["locked", "rate_limited", "unavailable", "other_account"] as const)(
    "la comprobación de la contraseña no pudo terminar (%s): mensaje general y nada de lo demás se toca",
    async (reason) => {
      confirmPassword.mockResolvedValue({ ok: false, reason, message: "Mensaje de prueba." });
      const state = await confirmForm(fields());
      expect(state).toEqual({ status: "error", message: "Mensaje de prueba." });
      expect(beginSecondStepAttempt).not.toHaveBeenCalled();
      expect(grantEnrollmentPermit).not.toHaveBeenCalled();
      expect(challengeAndVerify).not.toHaveBeenCalled();
    },
  );

  it("la contraseña nunca llega a la auditoría ni al registro ni vuelve en el estado (ni en éxito ni en error)", async () => {
    challengeAndVerify.mockResolvedValueOnce({
      error: { code: "mfa_verification_failed", status: 422 },
    });
    const failed = await confirmForm(fields());
    expect(failed.values).toBeUndefined();
    await redirectOf(() => confirmTotpEnrollmentAction(IDLE, fields({ code: "654321" })));
    const recorded = JSON.stringify([...logAuditEvent.mock.calls, ...serverLog.mock.calls]);
    expect(recorded).not.toContain(PASSWORD);
    expect(JSON.stringify(failed)).not.toContain(PASSWORD);
  });

  it("bloqueada: no llama a Supabase", async () => {
    beginSecondStepAttempt.mockResolvedValue("short");
    const state = await confirmForm(fields());
    expect(state.message).toMatch(/Demasiados intentos/);
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("código ya usado: se rechaza antes de verificar y no suma fallo", async () => {
    consumeTotpCode.mockResolvedValue(false);
    const state = await confirmForm(fields());
    expect(state.message).toBe("Ese código ya se usó. Espera el siguiente.");
    expect(recordSecondStepFailure).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("al activar se usan contadores PROPIOS (`enrollment`), distintos de los del ingreso con contraseña y de la recuperación", async () => {
    await redirectOf(() => confirmTotpEnrollmentAction(IDLE, fields()));
    expect(beginSecondStepAttempt).toHaveBeenCalledWith(USER.id, "enrollment");
    expect(clearSecondStepFailures).toHaveBeenCalledWith(USER.id, "enrollment");
    for (const mock of [beginSecondStepAttempt, clearSecondStepFailures, recordSecondStepFailure]) {
      for (const [, context] of mock.mock.calls) expect(context).toBe("enrollment");
    }
  });

  it("bloqueo de 24 h al activar: el mensaje manda a revisar la hora del teléfono, no dice que alguien tiene la contraseña", async () => {
    beginSecondStepAttempt.mockResolvedValue("day");
    const state = await confirmForm(fields());
    expect(state.message).toMatch(/hora de tu teléfono/);
    expect(state.message).not.toMatch(/contraseña|alguien/);
    expect(state.message).toMatch(/Demasiados intentos hoy/);
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.mfa_locked",
        details: { reason: "blocked", stage: "enrollment", factorType: "totp" },
      }),
    );
  });

  it.each([
    [
      "un factor ajeno o inexistente",
      { all: [{ id: "otro", status: "unverified", factor_type: "totp" }] },
    ],
    [
      "un factor que no es de aplicación",
      { all: [{ id: FACTOR_ID, status: "unverified", factor_type: "phone" }] },
    ],
  ])("%s => «La activación caducó» y no se verifica", async (_name, data) => {
    listFactors.mockResolvedValue({ data, error: null });
    const state = await confirmForm(fields());
    expect(state.message).toBe("La activación caducó. Recarga la página y vuelve a empezar.");
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("si no se puede leer la lista de factores, también «caducó» (lado seguro)", async () => {
    listFactors.mockResolvedValue({ data: null, error: { code: "x" } });
    expect((await confirmForm(fields())).message).toBe(
      "La activación caducó. Recarga la página y vuelve a empezar.",
    );
  });

  it("activar desde dos pestañas (menor 7): si la cuenta YA tiene el factor verificado, lleva a la pantalla de seguridad (está activa) en vez de decir «caducó», y libera el código", async () => {
    listFactors.mockResolvedValue({
      data: { all: [{ id: "otra-pestana", status: "verified", factor_type: "totp" }] },
      error: null,
    });
    const target = await redirectOf(() => confirmTotpEnrollmentAction(IDLE, fields()));
    expect(target).toBe("/cuenta/seguridad");
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(releaseTotpCode).toHaveBeenCalledWith(USER.id, "123456");
    expect(recordSecondStepFailure).not.toHaveBeenCalled();
  });

  it("con otro factor que no es de aplicación verificado (o sin ninguno), sigue siendo «caducó» y sugiere recargar la página", async () => {
    listFactors.mockResolvedValue({
      data: { all: [{ id: "tel", status: "verified", factor_type: "phone" }] },
      error: null,
    });
    const state = await confirmForm(fields());
    expect(state.message).toMatch(/caducó\. Recarga la página/);
  });

  it("código incorrecto: suma un fallo (a los contadores PROPIOS de la activación) y deja auditoría", async () => {
    challengeAndVerify.mockResolvedValue({
      error: { code: "mfa_verification_failed", status: 422 },
    });
    const state = await confirmForm(fields());
    expect(state.message).toMatch(/El código no coincide/);
    expect(recordSecondStepFailure).toHaveBeenCalledWith(USER.id, "enrollment", IP);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.mfa_failed",
        details: { reason: "mfa_invalid_code", stage: "enrollment", factorType: "totp" },
      }),
    );
  });

  it("el 429 de Supabase al activar libera el código y no suma al tope del día ni al de la IP", async () => {
    challengeAndVerify.mockResolvedValue({
      error: { code: "over_request_rate_limit", status: 429 },
    });
    const state = await confirmForm(fields());
    expect(state.message).toMatch(/Demasiados intentos/);
    expect(releaseTotpCode).toHaveBeenCalledWith(USER.id, "123456");
    expect(recordSecondStepFailure).not.toHaveBeenCalled();
  });

  it("si Supabase falla por otra cosa, el código se libera y el mensaje es el de activar de nuevo (no el de ingresar)", async () => {
    challengeAndVerify.mockResolvedValue({ error: { code: "mfa_challenge_expired", status: 422 } });
    const state = await confirmForm(fields());
    expect(state.message).toBe("La activación caducó. Recarga la página y vuelve a empezar.");
    expect(releaseTotpCode).toHaveBeenCalledWith(USER.id, "123456");
    expect(recordSecondStepFailure).not.toHaveBeenCalled();
  });

  it("éxito: verifica en una llamada, audita en la plataforma y en cada organización, y DEVUELVE los códigos de respaldo en vez de redirigir", async () => {
    const result = await redirectOf(() => confirmTotpEnrollmentAction(IDLE, fields()));
    expect(result).toEqual({
      returned: {
        status: "enabled",
        recoveryCodes: CODES_ISSUED.recoveryCodes,
        setId: CODES_ISSUED.setId,
      },
    });
    expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: FACTOR_ID, code: "123456" });
    expect(clearSecondStepFailures).toHaveBeenCalledWith(USER.id, "enrollment");
    const enrolled = logAuditEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.action === "session.mfa_enrolled");
    expect(enrolled.map((event) => event.tenantId)).toEqual([undefined, "t1", "t2"]);
    for (const event of enrolled) {
      expect(event.details).toEqual({ stage: "enrollment", factorType: "totp" });
    }
  });

  it("deja el permiso ANTES de verificar y verifica con un solo desafío; sin permiso no verifica y libera el código", async () => {
    await redirectOf(() => confirmTotpEnrollmentAction(IDLE, fields()));
    expect(grantEnrollmentPermit).toHaveBeenCalledWith(USER.id, FACTOR_ID);
    expect(grantEnrollmentPermit.mock.invocationCallOrder[0]).toBeLessThan(
      challengeAndVerify.mock.invocationCallOrder[0],
    );
    challengeAndVerify.mockClear();
    grantEnrollmentPermit.mockResolvedValue(false);
    const denied = await confirmForm(fields());
    expect(denied.message).toMatch(/No pudimos verificar el código/);
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(releaseTotpCode).toHaveBeenCalledWith(USER.id, "123456");
    grantEnrollmentPermit.mockRejectedValue(new Error("x"));
    const failed = await confirmForm(fields());
    expect(failed.status).toBe("error");
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("los avisos pendientes salen SIEMPRE, también si la verificación falla; y entonces se cierra el permiso (un código incorrecto no deja la puerta abierta 2 minutos)", async () => {
    challengeAndVerify.mockResolvedValue({
      error: { code: "mfa_verification_failed", status: 422 },
    });
    deliverPendingEnrollmentNotices.mockResolvedValue({
      sentFactorIds: [],
      sentTo: null,
      failures: [],
    });
    const state = await confirmForm(fields());
    expect(state.message).toMatch(/El código no coincide/);
    expect(deliverPendingEnrollmentNotices).toHaveBeenCalledWith(USER.id);
    expect(revertEnrollmentAlert).toHaveBeenCalledWith(USER.id, FACTOR_ID, "verify_failed", {
      onlyPermit: true,
    });
    // Y no se borra el factor sin verificar: la persona reintenta con el mismo QR.
    expect(revertEnrollment).not.toHaveBeenCalled();
  });

  it("si alguien verificó el factor directo mientras el permiso vivía y el aviso no salió, se revierte aunque el código de aquí fuera incorrecto", async () => {
    challengeAndVerify.mockResolvedValue({
      error: { code: "mfa_verification_failed", status: 422 },
    });
    deliverPendingEnrollmentNotices.mockResolvedValue({
      sentFactorIds: [],
      sentTo: null,
      failures: [{ alertId: "a1", factorId: FACTOR_ID, code: "provider_rejected" }],
    });
    await confirmTotpEnrollmentAction(IDLE, fields());
    expect(revertEnrollment).toHaveBeenCalledWith(USER.id, FACTOR_ID, "provider_rejected");
    // Y si el permiso estaba vivo y la base lo da como revertido (pendiente sin intento), también se borra el factor.
    revertEnrollment.mockClear();
    deliverPendingEnrollmentNotices.mockResolvedValue({
      sentFactorIds: [],
      sentTo: null,
      failures: [],
    });
    // La base devuelve `pending` (sin tocarlo): el servidor borra el factor PRIMERO y recién después lo anota.
    revertEnrollmentAlert.mockResolvedValue("pending");
    await confirmTotpEnrollmentAction(IDLE, fields());
    expect(revertEnrollment).toHaveBeenCalledWith(USER.id, FACTOR_ID, "verify_failed");
  });

  it("el aviso sale DESPUÉS de verificar y la activación solo se audita y se celebra si el aviso salió", async () => {
    const result = await confirmTotpEnrollmentAction(IDLE, fields());
    expect(result.status).toBe("enabled");
    expect(deliverPendingEnrollmentNotices.mock.invocationCallOrder[0]).toBeGreaterThan(
      challengeAndVerify.mock.invocationCallOrder[0],
    );
    expect(revertEnrollment).not.toHaveBeenCalled();
    expect(auditActions()).toContain("session.mfa_enrolled");
  });

  it.each([
    ["el proveedor no acepta el correo", "provider_rejected"],
    ["hay un error de configuración del correo", "email_config"],
    ["el destinatario no está permitido", "recipient_not_allowed"],
  ])(
    "si %s, se REVIERTE la activación, se dice con su mensaje y no se audita como activada",
    async (_name, code) => {
      deliverPendingEnrollmentNotices.mockResolvedValue({
        sentFactorIds: [],
        sentTo: null,
        failures: [{ alertId: "a1", factorId: FACTOR_ID, code }],
      });
      const state = await confirmForm(fields());
      expect(state).toEqual({
        status: "error",
        message:
          "No pudimos enviarte el correo de aviso, así que no dejamos activa la verificación. Inténtalo de nuevo en unos minutos.",
      });
      expect(revertEnrollment).toHaveBeenCalledWith(USER.id, FACTOR_ID, code);
      expect(auditActions()).not.toContain("session.mfa_enrolled");
      expect(logTenantLogins).not.toHaveBeenCalled();
      expect(activeTenantIdsOf).not.toHaveBeenCalled();
    },
  );

  it("si el aviso no salió y tampoco se pudo revertir, lo dice distinto (la persona tiene que pedir ayuda)", async () => {
    deliverPendingEnrollmentNotices.mockResolvedValue({
      sentFactorIds: [],
      sentTo: null,
      failures: [{ alertId: null, factorId: null, code: "gateway_shape" }],
    });
    revertEnrollment.mockResolvedValue(false);
    const state = await confirmForm(fields());
    expect(state.message).toMatch(/quedó activa sin él/);
    expect(revertEnrollment).toHaveBeenCalledWith(USER.id, FACTOR_ID, "gateway_shape");
  });

  it("la auditoría de la activación nunca lleva el correo ni el aviso", async () => {
    await redirectOf(() => confirmTotpEnrollmentAction(IDLE, fields()));
    expect(JSON.stringify([...logAuditEvent.mock.calls, ...serverLog.mock.calls])).not.toContain(
      USER.email,
    );
  });

  it("los códigos de respaldo se crean al FINAL: después del aviso y de la auditoría, con el factor recién verificado y para la etapa «enrollment»", async () => {
    await confirmTotpEnrollmentAction(IDLE, fields());
    expect(issueRecoveryCodes).toHaveBeenCalledTimes(1);
    expect(issueRecoveryCodes).toHaveBeenCalledWith(USER.id, FACTOR_ID, "enrollment");
    const issuedAt = issueRecoveryCodes.mock.invocationCallOrder[0];
    expect(issuedAt).toBeGreaterThan(challengeAndVerify.mock.invocationCallOrder[0]);
    expect(issuedAt).toBeGreaterThan(deliverPendingEnrollmentNotices.mock.invocationCallOrder[0]);
    const lastAudit = Math.max(...logAuditEvent.mock.invocationCallOrder);
    expect(issuedAt).toBeGreaterThan(lastAudit);
    expect(clearSecondStepFailures.mock.invocationCallOrder[0]).toBeLessThan(issuedAt);
  });

  it("si el aviso no salió y la activación se revierte, NO se crean códigos de respaldo", async () => {
    deliverPendingEnrollmentNotices.mockResolvedValue({
      sentFactorIds: [],
      sentTo: null,
      failures: [{ alertId: "a1", factorId: FACTOR_ID, code: "provider_rejected" }],
    });
    await confirmTotpEnrollmentAction(IDLE, fields());
    expect(issueRecoveryCodes).not.toHaveBeenCalled();
  });

  it("con contraseña o código incorrectos tampoco se crean códigos de respaldo", async () => {
    confirmPassword.mockResolvedValueOnce({
      ok: false,
      reason: "wrong_password",
      message: "La contraseña no es correcta.",
    });
    await confirmTotpEnrollmentAction(IDLE, fields());
    challengeAndVerify.mockResolvedValueOnce({
      error: { code: "mfa_verification_failed", status: 422 },
    });
    await confirmTotpEnrollmentAction(IDLE, fields());
    expect(issueRecoveryCodes).not.toHaveBeenCalled();
  });

  it("si NO se pueden crear los códigos, la verificación sigue activa y la respuesta lo dice (sin revertir nada)", async () => {
    issueRecoveryCodes.mockResolvedValue({ ok: false, reason: "error" });
    const result = await confirmTotpEnrollmentAction(IDLE, fields());
    expect(result).toEqual({ status: "enabled_without_codes" });
    expect(revertEnrollment).not.toHaveBeenCalled();
    expect(auditActions()).toContain("session.mfa_enrolled");
  });

  it("los códigos de respaldo viajan solo en la respuesta: nunca en la auditoría ni en el registro del servidor", async () => {
    await confirmTotpEnrollmentAction(IDLE, fields());
    const recorded = JSON.stringify([...logAuditEvent.mock.calls, ...serverLog.mock.calls]);
    for (const code of CODES_ISSUED.recoveryCodes) expect(recorded).not.toContain(code);
    expect(recorded).not.toContain(CODES_ISSUED.setId);
  });

  it("activar desde dos pestañas sigue llevando a la pantalla de seguridad y NO crea códigos", async () => {
    listFactors.mockResolvedValue({
      data: { all: [{ id: "otra-pestana", status: "verified", factor_type: "totp" }] },
      error: null,
    });
    await redirectOf(() => confirmTotpEnrollmentAction(IDLE, fields()));
    expect(issueRecoveryCodes).not.toHaveBeenCalled();
  });

  it("no mira rol ni organización activa ni lee tablas (solo recorre las organizaciones para auditar)", async () => {
    await redirectOf(() => confirmTotpEnrollmentAction(IDLE, fields()));
    expect(requireUser).toHaveBeenCalledTimes(1);
    expect(requireActiveTenant).not.toHaveBeenCalled();
    expect(requirePermission).not.toHaveBeenCalled();
    expect(tableReads).not.toHaveBeenCalled();
    expect(rpcCalls).not.toHaveBeenCalled();
  });
});

describe("cancelTotpEnrollmentAction (cancelar la activación, menor 6)", () => {
  beforeEach(() => {
    unenroll.mockResolvedValue({ data: {}, error: null });
  });
  const list = (all: Array<{ id: string; status: string; factor_type: string }>) =>
    listFactors.mockResolvedValue({ data: { all }, error: null });

  it("quita el factor SIN verificar de esa persona, con su propio pase, y nada más", async () => {
    list([
      { id: FACTOR_ID, status: "unverified", factor_type: "totp" },
      { id: "otro-sin-verificar", status: "unverified", factor_type: "totp" },
    ]);
    await cancelTotpEnrollmentAction(FACTOR_ID);
    expect(requireUser).toHaveBeenCalledTimes(1);
    expect(unenroll).toHaveBeenCalledTimes(1);
    expect(unenroll).toHaveBeenCalledWith({ factorId: FACTOR_ID });
  });

  it.each([
    [
      "un factor verificado (el que protege la cuenta)",
      [{ id: FACTOR_ID, status: "verified", factor_type: "totp" }],
    ],
    [
      "un factor que no es de aplicación",
      [{ id: FACTOR_ID, status: "unverified", factor_type: "phone" }],
    ],
    ["un factor ajeno o inexistente", [{ id: "otro", status: "unverified", factor_type: "totp" }]],
    ["ningún factor", []],
  ])("no quita %s", async (_name, all) => {
    list(all);
    await cancelTotpEnrollmentAction(FACTOR_ID);
    expect(unenroll).not.toHaveBeenCalled();
  });

  it("un identificador vacío no consulta nada", async () => {
    await cancelTotpEnrollmentAction("");
    expect(listFactors).not.toHaveBeenCalled();
    expect(unenroll).not.toHaveBeenCalled();
  });

  it("si no se puede leer la lista o quitar el factor, no se lanza ningún error (no bloquea la salida) y solo se registra el código", async () => {
    listFactors.mockResolvedValue({ data: null, error: { code: "boom" } });
    await expect(cancelTotpEnrollmentAction(FACTOR_ID)).resolves.toBeUndefined();
    expect(unenroll).not.toHaveBeenCalled();
    list([{ id: FACTOR_ID, status: "unverified", factor_type: "totp" }]);
    unenroll.mockResolvedValue({ data: null, error: { code: "unexpected_failure" } });
    await expect(cancelTotpEnrollmentAction(FACTOR_ID)).resolves.toBeUndefined();
    expect(unenroll).toHaveBeenCalledTimes(1);
    expect(serverLog).toHaveBeenCalledWith("error", "mfa_unenroll_failed", {
      code: "unexpected_failure",
    });
    for (const [, , fields] of serverLog.mock.calls) expect(Object.keys(fields)).toEqual(["code"]);
  });

  it("no mira rol ni organización, no lee tablas ni usa la llave maestra", async () => {
    list([{ id: FACTOR_ID, status: "unverified", factor_type: "totp" }]);
    await cancelTotpEnrollmentAction(FACTOR_ID);
    expect(requireActiveTenant).not.toHaveBeenCalled();
    expect(requirePermission).not.toHaveBeenCalled();
    expect(tableReads).not.toHaveBeenCalled();
    expect(rpcCalls).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});
