import { beforeEach, describe, expect, it, vi } from "vitest";
import { RedirectSignal } from "@/test/supabase-mock";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ana@ejemplo.test",
  emailVerified: true,
};
const FACTOR_ID = "22222222-2222-4222-8222-222222222222";
const IP = "203.0.113.7";

const challengeAndVerify = vi.fn();
const listFactors = vi.fn();
const unenroll = vi.fn();
const enroll = vi.fn();
const supabase = { auth: { mfa: { challengeAndVerify, listFactors, unenroll, enroll } } };
const logAuditEvent = vi.fn();
const serverLog = vi.fn();
const getSessionState = vi.fn();
const requirePendingSecondStep = vi.fn();
const requireUser = vi.fn();
const hasRecoverySession = vi.fn();
const hasPendingInvitation = vi.fn();
const logTenantLogins = vi.fn();
const activeTenantIdsOf = vi.fn();
const isSecondStepLocked = vi.fn();
const recordSecondStepFailure = vi.fn();
const clearSecondStepFailures = vi.fn();
const consumeTotpCode = vi.fn();

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
vi.mock("@/lib/auth/login-audit", () => ({
  logTenantLogins: (...args: unknown[]) => logTenantLogins(...args),
  activeTenantIdsOf: (...args: unknown[]) => activeTenantIdsOf(...args),
}));
vi.mock("@/lib/http/request-context", () => ({
  getRequestContext: async () => ({ requestId: "r", clientIp: IP, userAgent: null }),
}));
vi.mock("@/lib/security/login-rate-limit", () => ({
  RATE_LIMITED_MESSAGE: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
  isSecondStepLocked: (...args: unknown[]) => isSecondStepLocked(...args),
  recordSecondStepFailure: (...args: unknown[]) => recordSecondStepFailure(...args),
  clearSecondStepFailures: (...args: unknown[]) => clearSecondStepFailures(...args),
  consumeTotpCode: (...args: unknown[]) => consumeTotpCode(...args),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));
vi.mock("@/lib/team/invitation-cookie", () => ({
  hasPendingInvitation: () => hasPendingInvitation(),
}));

const { confirmTotpEnrollmentAction, startTotpEnrollmentAction, verifySecondStepAction } =
  await import("./second-step-actions");

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const IDLE = { status: "idle" } as const;
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
    isSecondStepLocked,
    recordSecondStepFailure,
    clearSecondStepFailures,
    consumeTotpCode,
  ]) {
    mock.mockReset();
  }
  getSessionState.mockResolvedValue(PENDING_STATE);
  requirePendingSecondStep.mockResolvedValue(USER);
  requireUser.mockResolvedValue(USER);
  hasRecoverySession.mockResolvedValue(false);
  hasPendingInvitation.mockResolvedValue(false);
  isSecondStepLocked.mockResolvedValue(false);
  recordSecondStepFailure.mockResolvedValue(false);
  consumeTotpCode.mockResolvedValue(true);
  challengeAndVerify.mockResolvedValue({ data: {}, error: null });
  activeTenantIdsOf.mockResolvedValue([]);
});

const auditActions = () => logAuditEvent.mock.calls.map(([event]) => event.action);

describe("verifySecondStepAction (código tras la contraseña)", () => {
  it("exige una sesión parcial: sin sesión o con sesión completa la redirección la hace session.ts y no se consulta nada", async () => {
    requirePendingSecondStep.mockRejectedValue(new RedirectSignal("/"));
    expect(await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "123456" })))).toBe(
      "/",
    );
    expect(isSecondStepLocked).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it.each(["12345", "1234567", "12345a", "", "abcdef"])(
    "un código mal escrito (%j) da error en el campo y no consulta límites ni a Supabase",
    async (code) => {
      const state = await verifySecondStepAction(IDLE, form({ code }));
      expect(state.status).toBe("error");
      expect(state.fieldErrors?.code).toBeTruthy();
      expect(isSecondStepLocked).not.toHaveBeenCalled();
      expect(consumeTotpCode).not.toHaveBeenCalled();
      expect(challengeAndVerify).not.toHaveBeenCalled();
    },
  );

  it("cuenta bloqueada: responde «demasiados intentos» y NO llama a Supabase ni gasta el código", async () => {
    isSecondStepLocked.mockResolvedValue(true);
    const state = await verifySecondStepAction(IDLE, form({ code: "123456" }));
    expect(state.message).toMatch(/Demasiados intentos/);
    expect(consumeTotpCode).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["session.mfa_locked"]);
  });

  it("el límite se revisa con la cuenta y la IP, ANTES de llamar a Supabase", async () => {
    const order: string[] = [];
    isSecondStepLocked.mockImplementation(async () => (order.push("limite"), false));
    challengeAndVerify.mockImplementation(async () => (order.push("supabase"), { error: null }));
    await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "123456" })));
    expect(order).toEqual(["limite", "supabase"]);
    expect(isSecondStepLocked).toHaveBeenCalledWith(USER.id, IP);
  });

  it("un código ya usado cuenta como fallo, se avisa y NO se llama a Supabase", async () => {
    consumeTotpCode.mockResolvedValue(false);
    const state = await verifySecondStepAction(IDLE, form({ code: "123456" }));
    expect(state.message).toBe("Ese código ya se usó. Espera el siguiente.");
    expect(recordSecondStepFailure).toHaveBeenCalledWith(USER.id, IP);
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.mfa_failed",
        details: { reason: "code_reused", stage: "sign_in", factorType: "totp" },
      }),
    );
  });

  it("un código incorrecto suma un fallo, deja auditoría y no muestra el código", async () => {
    challengeAndVerify.mockResolvedValue({
      error: { code: "mfa_verification_failed", status: 422 },
    });
    const state = await verifySecondStepAction(IDLE, form({ code: "654321" }));
    expect(state.status).toBe("error");
    expect(state.message).toMatch(/El código no coincide/);
    expect(JSON.stringify(state)).not.toContain("654321");
    expect(recordSecondStepFailure).toHaveBeenCalledWith(USER.id, IP);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.mfa_failed",
        result: "failure",
        actorUserId: USER.id,
      }),
    );
    expect(clearSecondStepFailures).not.toHaveBeenCalled();
  });

  it("el fallo que llena el cupo bloquea: mensaje de demasiados intentos y auditoría mfa_locked", async () => {
    challengeAndVerify.mockResolvedValue({
      error: { code: "mfa_verification_failed", status: 422 },
    });
    recordSecondStepFailure.mockResolvedValue(true);
    const state = await verifySecondStepAction(IDLE, form({ code: "654321" }));
    expect(state.message).toMatch(/Demasiados intentos/);
    expect(auditActions()).toEqual(["session.mfa_failed", "session.mfa_locked"]);
  });

  it("el 429 de Supabase no cuenta como fallo", async () => {
    challengeAndVerify.mockResolvedValue({
      error: { code: "over_request_rate_limit", status: 429 },
    });
    const state = await verifySecondStepAction(IDLE, form({ code: "123456" }));
    expect(state.message).toMatch(/Demasiados intentos/);
    expect(recordSecondStepFailure).not.toHaveBeenCalled();
  });

  it("otros errores de Supabase (por ejemplo, IP distinta) no suman al bloqueo y dan un mensaje claro", async () => {
    challengeAndVerify.mockResolvedValue({
      error: { code: "mfa_ip_address_mismatch", status: 422 },
    });
    const state = await verifySecondStepAction(IDLE, form({ code: "123456" }));
    expect(state.message).toMatch(/No pudimos verificar el código/);
    expect(recordSecondStepFailure).not.toHaveBeenCalled();
  });

  it("sin factor de aplicación verificado no se llama a Supabase", async () => {
    getSessionState.mockResolvedValue({ ...PENDING_STATE, factorId: null });
    const state = await verifySecondStepAction(IDLE, form({ code: "123456" }));
    expect(state.status).toBe("error");
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("desafío y verificación van en UNA sola llamada con el factor y el código", async () => {
    await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "123 456" })));
    expect(challengeAndVerify).toHaveBeenCalledTimes(1);
    expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: FACTOR_ID, code: "123456" });
  });

  it("éxito: limpia los fallos, audita, escribe el ingreso por organización con el MISMO cliente y va al inicio", async () => {
    const target = await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "123456" })));
    expect(target).toBe("/");
    expect(clearSecondStepFailures).toHaveBeenCalledWith(USER.id);
    expect(logAuditEvent).toHaveBeenCalledWith({
      action: "session.mfa_verified",
      result: "success",
      actorUserId: USER.id,
      details: { stage: "sign_in", factorType: "totp" },
    });
    expect(logTenantLogins).toHaveBeenCalledWith(supabase, USER.id);
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
    challengeAndVerify.mockResolvedValue({
      error: { code: "mfa_verification_failed", status: 422 },
    });
    await verifySecondStepAction(IDLE, form({ code: "987654" }));
    await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "246801" })));
    const everything = JSON.stringify([...logAuditEvent.mock.calls, ...serverLog.mock.calls]);
    expect(everything).not.toMatch(/987654|246801|otpauth|secret/);
    for (const [, , fields] of serverLog.mock.calls) {
      expect(Object.keys(fields ?? {}).sort()).toEqual(["code", "stage"]);
    }
  });

  it("no consulta rol ni organización activa (es de la cuenta)", async () => {
    await redirectOf(() => verifySecondStepAction(IDLE, form({ code: "123456" })));
    expect(JSON.stringify(Object.keys(supabase))).not.toMatch(/from|rpc/);
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
    expect(enroll).toHaveBeenCalledWith({ factorType: "totp", issuer: "Cotiza Prime" });
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

  it("no mira rol ni organización: solo exige una sesión completa", async () => {
    await startTotpEnrollmentAction();
    expect(requireUser).toHaveBeenCalledTimes(1);
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
  const fields = (extra: Record<string, string> = {}) =>
    form({ factorId: FACTOR_ID, code: "123456", ...extra });

  it("un código mal escrito no consulta nada", async () => {
    const state = await confirmTotpEnrollmentAction(IDLE, fields({ code: "12" }));
    expect(state.fieldErrors?.code).toBeTruthy();
    expect(listFactors).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("bloqueada: no llama a Supabase", async () => {
    isSecondStepLocked.mockResolvedValue(true);
    const state = await confirmTotpEnrollmentAction(IDLE, fields());
    expect(state.message).toMatch(/Demasiados intentos/);
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("código ya usado: se rechaza antes de verificar", async () => {
    consumeTotpCode.mockResolvedValue(false);
    const state = await confirmTotpEnrollmentAction(IDLE, fields());
    expect(state.message).toBe("Ese código ya se usó. Espera el siguiente.");
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it.each([
    [
      "un factor ajeno o inexistente",
      { all: [{ id: "otro", status: "unverified", factor_type: "totp" }] },
    ],
    [
      "un factor ya verificado",
      { all: [{ id: FACTOR_ID, status: "verified", factor_type: "totp" }] },
    ],
    [
      "un factor que no es de aplicación",
      { all: [{ id: FACTOR_ID, status: "unverified", factor_type: "phone" }] },
    ],
  ])("%s => «La activación caducó» y no se verifica", async (_name, data) => {
    listFactors.mockResolvedValue({ data, error: null });
    const state = await confirmTotpEnrollmentAction(IDLE, fields());
    expect(state.message).toBe("La activación caducó. Vuelve a empezar.");
    expect(challengeAndVerify).not.toHaveBeenCalled();
  });

  it("si no se puede leer la lista de factores, también «caducó» (lado seguro)", async () => {
    listFactors.mockResolvedValue({ data: null, error: { code: "x" } });
    expect((await confirmTotpEnrollmentAction(IDLE, fields())).message).toBe(
      "La activación caducó. Vuelve a empezar.",
    );
  });

  it("código incorrecto: suma un fallo y deja auditoría de la activación", async () => {
    challengeAndVerify.mockResolvedValue({
      error: { code: "mfa_verification_failed", status: 422 },
    });
    const state = await confirmTotpEnrollmentAction(IDLE, fields());
    expect(state.message).toMatch(/El código no coincide/);
    expect(recordSecondStepFailure).toHaveBeenCalledWith(USER.id, IP);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "session.mfa_failed",
        details: { reason: "mfa_invalid_code", stage: "enrollment", factorType: "totp" },
      }),
    );
  });

  it("éxito: verifica en una llamada, audita en la plataforma y en cada organización, y vuelve a la pantalla con el aviso", async () => {
    const target = await redirectOf(() => confirmTotpEnrollmentAction(IDLE, fields()));
    expect(target).toBe("/cuenta/seguridad?aviso=activada");
    expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: FACTOR_ID, code: "123456" });
    expect(clearSecondStepFailures).toHaveBeenCalledWith(USER.id);
    const enrolled = logAuditEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.action === "session.mfa_enrolled");
    expect(enrolled.map((event) => event.tenantId)).toEqual([undefined, "t1", "t2"]);
    for (const event of enrolled) {
      expect(event.details).toEqual({ stage: "enrollment", factorType: "totp" });
    }
  });

  it("no mira rol ni organización activa", async () => {
    await redirectOf(() => confirmTotpEnrollmentAction(IDLE, fields()));
    expect(requireUser).toHaveBeenCalledTimes(1);
  });
});
