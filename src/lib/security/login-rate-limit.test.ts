import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin-client", () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn() }));
vi.mock("@/lib/crypto/search-hash", () => ({
  // Huella legible para comprobar qué se está contando
  searchHash: (field: string, _tenant: string, value: string) => `${field}|${value}`,
}));

import {
  MFA_CODE_REGISTRATIONS_TO_BLOCK,
  MFA_CODE_REUSE_SECONDS,
  MFA_DAY_SECONDS,
  MFA_LOCK_SECONDS,
  MFA_MAX_ATTEMPTS_PER_ACCOUNT,
  MFA_MAX_FAILURES_PER_ACCOUNT_PER_DAY,
  MFA_WINDOW_SECONDS,
  beginSecondStepAttempt,
  clearPasswordPathSecondStepCounters,
  clearSecondStepFailures,
  consumeTotpCode,
  isSecondStepIpLocked,
  recordSecondStepFailure,
  releaseTotpCode,
  recordLoginFailure,
  INVITATION_LINK_MAX_PER_IP_PER_WINDOW,
  consumeInvitationLinkQuota,
  INTAKE_READ_MAX_PER_IP_PER_WINDOW,
  INTAKE_SUBMIT_MAX_PER_IP_PER_DAY,
  INTAKE_SUBMIT_MAX_PER_IP_PER_WINDOW,
  consumeIntakeReadQuota,
  consumeIntakeSubmitQuota,
  SEND_MAX_PER_USER_PER_WINDOW,
  SHARE_RESPOND_MAX_PER_IP_PER_WINDOW,
  consumeShareRespondQuota,
  SHARE_MAX_READS_PER_IP_PER_WINDOW,
  SHARE_MAX_READS_PER_LINK_PER_WINDOW,
  TENANT_DENIED_MAX_LOGGED_PER_WINDOW,
  consumeSendQuota,
  consumeShareQuota,
  ipLimitKey,
  recordResetRequest,
  recordSignupAttempt,
  shouldLogTenantDenied,
} from "./login-rate-limit";

beforeEach(() => rpc.mockReset().mockResolvedValue({ data: null, error: null }));
afterEach(() => vi.unstubAllEnvs());

describe("pedidos de restablecer contraseña (H-003)", () => {
  it("cuenta por cuenta y por IP, con huellas distintas a las del ingreso", async () => {
    await recordResetRequest("Ana@Ejemplo.test", "203.0.113.7");
    const keys = rpc.mock.calls.map(([, args]) => args.p_key_hash);
    expect(keys).toEqual(["reset_email|ana@ejemplo.test", "reset_ip|203.0.113.7"]);
  });
});

describe("ipLimitKey", () => {
  it("una IPv4 cuenta tal cual", () => {
    expect(ipLimitKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("una IPv6 se agrupa por bloque /64, sin importar los últimos 64 bits", () => {
    const a = ipLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    const b = ipLimitKey("2001:db8:1:2::1");
    expect(a).toBe("2001:0db8:0001:0002::/64");
    expect(b).toBe(a);
    expect(ipLimitKey("2001:db8:1:3::1")).not.toBe(a);
  });

  it("expande bien las formas abreviadas", () => {
    expect(ipLimitKey("::1")).toBe("0000:0000:0000:0000::/64");
    expect(ipLimitKey("2001:db8::")).toBe("2001:0db8:0000:0000::/64");
    expect(ipLimitKey("2001:DB8::5:6")).toBe("2001:0db8:0000:0000::/64");
  });

  it("una IPv4 escrita como IPv6 cuenta como IPv4", () => {
    expect(ipLimitKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });
});

describe("registro sin IP conocida", () => {
  it("en producción cuenta en el grupo 'desconocida'", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await recordSignupAttempt(null);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_scope: "signup_ip",
      p_key_hash: "signup_ip|desconocida",
    });
  });

  it("fuera de producción no se limita sin IP", async () => {
    vi.stubEnv("NODE_ENV", "test");
    await recordSignupAttempt(null);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("shouldLogTenantDenied", () => {
  it("registra hasta el tope y deja de registrar al pasarlo", async () => {
    let calls = 0;
    rpc.mockImplementation(async () => {
      calls += 1;
      // la base bloquea al llegar al máximo configurado (tope + 1)
      return {
        data: calls > TENANT_DENIED_MAX_LOGGED_PER_WINDOW ? "2026-10-01T00:00:00Z" : null,
        error: null,
      };
    });
    const results: boolean[] = [];
    for (let i = 0; i < TENANT_DENIED_MAX_LOGGED_PER_WINDOW + 3; i += 1) {
      results.push(await shouldLogTenantDenied("u1"));
    }
    expect(results.filter(Boolean)).toHaveLength(TENANT_DENIED_MAX_LOGGED_PER_WINDOW);
    expect(results.slice(0, TENANT_DENIED_MAX_LOGGED_PER_WINDOW).every(Boolean)).toBe(true);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_scope: "tenant_denied_user",
      p_max_failures: TENANT_DENIED_MAX_LOGGED_PER_WINDOW + 1,
    });
  });

  it("si el contador falla, se registra igual", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    expect(await shouldLogTenantDenied("u1")).toBe(true);
  });
});

describe("consumeSendQuota (H-029)", () => {
  it("deja pasar hasta el tope y bloquea el siguiente", async () => {
    let calls = 0;
    rpc.mockImplementation(async () => {
      calls += 1;
      return {
        data: calls > SEND_MAX_PER_USER_PER_WINDOW ? "2026-10-01T00:00:00Z" : null,
        error: null,
      };
    });
    const results: boolean[] = [];
    for (let i = 0; i < SEND_MAX_PER_USER_PER_WINDOW + 2; i += 1) {
      results.push(await consumeSendQuota("u1", "t1"));
    }
    expect(results.filter(Boolean)).toHaveLength(SEND_MAX_PER_USER_PER_WINDOW);
    expect(results.at(-1)).toBe(false);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_scope: "quote_send_user",
      p_key_hash: "quote_send_user|u1",
      p_max_failures: SEND_MAX_PER_USER_PER_WINDOW + 1,
    });
  });

  it("si el contador falla, se deja pasar", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    expect(await consumeSendQuota("u1", "t1")).toBe(true);
  });
});

describe("consumeShareRespondQuota (H-031)", () => {
  it("cuenta la IP con una huella y bloquea al pasar el tope", async () => {
    expect(await consumeShareRespondQuota("203.0.113.7")).toBe(true);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_scope: "share_respond_ip",
      p_key_hash: "share_respond_ip|203.0.113.7",
      p_max_failures: SHARE_RESPOND_MAX_PER_IP_PER_WINDOW + 1,
    });
    rpc.mockResolvedValue({ data: "2026-10-01T00:00:00Z", error: null });
    expect(await consumeShareRespondQuota("203.0.113.7")).toBe(false);
  });

  it("sin IP conocida, en producción cuenta en el grupo 'desconocida'", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await consumeShareRespondQuota(null)).toBe(true);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_scope: "share_respond_ip",
      p_key_hash: "share_respond_ip|desconocida",
    });
    rpc.mockResolvedValue({ data: "2026-10-01T00:00:00Z", error: null });
    expect(await consumeShareRespondQuota(null)).toBe(false);
  });

  it("sin IP conocida, fuera de producción no cuenta, y si el contador falla se deja pasar", async () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(await consumeShareRespondQuota(null)).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    expect(await consumeShareRespondQuota("203.0.113.7")).toBe(true);
  });
});

describe("consumeShareQuota (enlace del cliente, H-030)", () => {
  const SHA = "a".repeat(64);

  it("cuenta la IP y el enlace con huellas, nunca la IP ni el token en claro", async () => {
    expect(await consumeShareQuota("203.0.113.7", SHA)).toBe(true);
    const calls = rpc.mock.calls.map(([, args]) => args);
    expect(calls.map((c) => c.p_scope)).toEqual(["share_ip", "share_token"]);
    expect(calls[0]).toMatchObject({ p_max_failures: SHARE_MAX_READS_PER_IP_PER_WINDOW + 1 });
    expect(calls[1]).toMatchObject({ p_max_failures: SHARE_MAX_READS_PER_LINK_PER_WINDOW + 1 });
    expect(calls[0].p_key_hash).toBe("share_ip|203.0.113.7");
    expect(calls[1].p_key_hash).toBe(`share_token|${SHA}`);
  });

  it("sin IP conocida, en producción cuenta la IP en el grupo 'desconocida' y el enlace", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await consumeShareQuota(null, SHA);
    const calls = rpc.mock.calls.map(([, args]) => args);
    expect(calls.map((c) => c.p_scope)).toEqual(["share_ip", "share_token"]);
    expect(calls[0].p_key_hash).toBe("share_ip|desconocida");
  });

  it("sin IP conocida, fuera de producción solo limita por enlace", async () => {
    vi.stubEnv("NODE_ENV", "test");
    await consumeShareQuota(null, SHA);
    expect(rpc.mock.calls.map(([, args]) => args.p_scope)).toEqual(["share_token"]);
  });

  it("bloquea al pasar el tope por IP sin gastar el cupo del enlace", async () => {
    rpc.mockResolvedValue({ data: "2026-10-01T00:00:00Z", error: null });
    expect(await consumeShareQuota("203.0.113.7", SHA)).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("bloquea al pasar el tope por enlace", async () => {
    // Primero se cuenta la IP (pasa) y después el enlace (ya bloqueado).
    rpc
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: "2026-10-01T00:00:00Z", error: null });
    expect(await consumeShareQuota("203.0.113.7", SHA)).toBe(false);
  });

  it("si el contador falla, se deja pasar", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    expect(await consumeShareQuota("203.0.113.7", SHA)).toBe(true);
  });
});

describe("formulario público (H-087)", () => {
  it("envíos: cuenta la IP en la ventana de 10 minutos y en el día, con huellas y con las constantes del plan", async () => {
    expect(await consumeIntakeSubmitQuota("203.0.113.7")).toBe("allowed");
    const recorded = rpc.mock.calls
      .filter(([name]) => name === "auth_limit_record_failure")
      .map(([, args]) => args);
    expect(recorded.map((c) => c.p_scope)).toEqual(["intake_submit_ip", "intake_submit_ip_day"]);
    expect(recorded[0]).toMatchObject({
      p_key_hash: "intake_submit_ip|203.0.113.7",
      p_max_failures: 6,
      p_window_seconds: 600,
    });
    expect(recorded[1]).toMatchObject({
      p_key_hash: "intake_submit_ip_day|203.0.113.7",
      p_max_failures: 21,
      p_window_seconds: 86_400,
    });
    expect(INTAKE_SUBMIT_MAX_PER_IP_PER_WINDOW).toBe(5);
    expect(INTAKE_SUBMIT_MAX_PER_IP_PER_DAY).toBe(20);
  });

  it("el sexto envío en 10 minutos bloquea AHORA, sin gastar el cupo del día", async () => {
    rpc.mockImplementation(async (name: string) => ({
      data: name === "auth_limit_record_failure" ? "2026-10-01T00:00:00Z" : null,
      error: null,
    }));
    expect(await consumeIntakeSubmitQuota("203.0.113.7")).toBe("blocked_now");
    const recorded = rpc.mock.calls.filter(([name]) => name === "auth_limit_record_failure");
    expect(recorded).toHaveLength(1);
  });

  it("una IP que ya estaba bloqueada no suma ni cuenta como bloqueo nuevo", async () => {
    rpc.mockImplementation(async (name: string) => ({
      data: name === "auth_limit_locked_until" ? "2026-10-01T00:00:00Z" : null,
      error: null,
    }));
    expect(await consumeIntakeSubmitQuota("203.0.113.7")).toBe("blocked_repeat");
    expect(rpc.mock.calls.some(([name]) => name === "auth_limit_record_failure")).toBe(false);
  });

  it("el envío número 21 del día bloquea aunque la ventana corta esté libre", async () => {
    let records = 0;
    rpc.mockImplementation(async (name: string) => {
      if (name !== "auth_limit_record_failure") return { data: null, error: null };
      records += 1;
      return { data: records === 2 ? "2026-10-02T00:00:00Z" : null, error: null };
    });
    expect(await consumeIntakeSubmitQuota("203.0.113.7")).toBe("blocked_now");
  });

  it("una IPv6 se agrupa por bloque /64 y nunca se guarda la IP en claro", async () => {
    await consumeIntakeSubmitQuota("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    const keys = rpc.mock.calls.map(([, args]) => args.p_key_hash);
    expect(keys[0]).toBe("intake_submit_ip|2001:0db8:0001:0002::/64");
  });

  it("sin IP conocida, en producción cuenta en el grupo 'desconocida'; fuera de producción no limita", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await consumeIntakeSubmitQuota(null);
    expect(rpc.mock.calls[0][1].p_key_hash).toBe("intake_submit_ip|desconocida");
    rpc.mockClear();
    vi.stubEnv("NODE_ENV", "test");
    expect(await consumeIntakeSubmitQuota(null)).toBe("allowed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("lecturas de la página: 60 por minuto por IP", async () => {
    expect(await consumeIntakeReadQuota("203.0.113.7")).toBe(true);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_scope: "intake_read_ip",
      p_key_hash: "intake_read_ip|203.0.113.7",
      p_max_failures: INTAKE_READ_MAX_PER_IP_PER_WINDOW + 1,
      p_window_seconds: 60,
    });
    rpc.mockResolvedValue({ data: "2026-10-01T00:00:00Z", error: null });
    expect(await consumeIntakeReadQuota("203.0.113.7")).toBe(false);
  });

  it("si el contador falla se deja pasar: el tope diario vive dentro de la base", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    expect(await consumeIntakeSubmitQuota("203.0.113.7")).toBe("allowed");
    expect(await consumeIntakeReadQuota("203.0.113.7")).toBe(true);
  });
});

describe("aperturas del enlace de una invitación (H-009)", () => {
  it("30 por minuto por IP: la 31 es la que bloquea, con una huella de la IP", async () => {
    expect(await consumeInvitationLinkQuota("203.0.113.7")).toBe(true);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_scope: "invite_link_ip",
      p_key_hash: "invite_link_ip|203.0.113.7",
      p_max_failures: INVITATION_LINK_MAX_PER_IP_PER_WINDOW + 1,
      p_window_seconds: 60,
      p_lock_seconds: 60,
    });
    expect(INVITATION_LINK_MAX_PER_IP_PER_WINDOW).toBe(30);
    rpc.mockResolvedValue({ data: "2026-10-01T00:00:00Z", error: null });
    expect(await consumeInvitationLinkQuota("203.0.113.7")).toBe(false);
  });

  it("una IPv6 se agrupa por bloque /64", async () => {
    await consumeInvitationLinkQuota("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(rpc.mock.calls[0][1].p_key_hash).toBe("invite_link_ip|2001:0db8:0001:0002::/64");
  });

  it("sin IP conocida, en producción cuenta en el grupo 'desconocida'; fuera de producción no limita", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await consumeInvitationLinkQuota(null);
    expect(rpc.mock.calls[0][1].p_key_hash).toBe("invite_link_ip|desconocida");
    rpc.mockClear();
    vi.stubEnv("NODE_ENV", "test");
    expect(await consumeInvitationLinkQuota(null)).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("si el contador falla se deja pasar (la base cuenta aparte las aceptaciones fallidas)", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    expect(await consumeInvitationLinkQuota("203.0.113.7")).toBe(true);
  });
});

describe("código de la verificación en dos pasos (H-004a)", () => {
  const USER = "11111111-1111-4111-8111-111111111111";
  const IP = "203.0.113.7";
  const calls = () => rpc.mock.calls.map(([name, args]) => [name, args?.p_scope, args?.p_key_hash]);

  it("empezar un intento revisa el tope del día (solo lee) y REGISTRA el intento de la ventana, con las reglas del plan", async () => {
    expect(await beginSecondStepAttempt(USER, "password")).toBe("none");
    expect(calls()).toEqual([
      ["auth_limit_locked_until", "mfa_verify_user_day", `mfa_verify_user_day|${USER}`],
      ["auth_limit_record_failure", "mfa_verify_user", `mfa_verify_user|${USER}`],
    ]);
    // El intento número 6 es el que bloquea: la regla pide 6 y los primeros 5 pasan.
    expect(rpc.mock.calls[1][1]).toMatchObject({
      p_max_failures: MFA_MAX_ATTEMPTS_PER_ACCOUNT + 1,
      p_window_seconds: MFA_WINDOW_SECONDS,
      p_lock_seconds: MFA_LOCK_SECONDS,
    });
    expect([MFA_MAX_ATTEMPTS_PER_ACCOUNT, MFA_WINDOW_SECONDS, MFA_DAY_SECONDS]).toEqual([
      5, 900, 86_400,
    ]);
  });

  it("el camino de recuperación usa OTRAS huellas (mismo alcance de la tabla): los fallos de uno no bloquean al otro", async () => {
    await beginSecondStepAttempt(USER, "password");
    await beginSecondStepAttempt(USER, "recovery");
    await recordSecondStepFailure(USER, "password", null);
    await recordSecondStepFailure(USER, "recovery", null);
    await clearSecondStepFailures(USER, "recovery");
    const keys = calls().map(([, scope, key]) => `${scope}:${key}`);
    expect(keys).toContain(`mfa_verify_user:mfa_verify_user|${USER}`);
    expect(keys).toContain(`mfa_verify_user:mfa_verify_user|${USER}|recovery`);
    expect(keys).toContain(`mfa_verify_user_day:mfa_verify_user_day|${USER}|recovery`);
    // Ninguna huella de recuperación es igual a una de contraseña.
    const withRecovery = keys.filter((key) => key.includes("|recovery"));
    const withoutRecovery = keys.filter((key) => !key.includes("|recovery"));
    expect(withRecovery.length).toBeGreaterThan(0);
    expect(new Set(withoutRecovery).size).toBeGreaterThan(0);
    for (const key of withRecovery) expect(withoutRecovery).not.toContain(key);
    // El alcance de la tabla es el mismo: no hace falta migración.
    expect(new Set(calls().map(([, scope]) => scope))).toEqual(
      new Set(["mfa_verify_user_day", "mfa_verify_user"]),
    );
  });

  it("la activación usa OTRAS huellas (`|enroll`, mismo alcance de la tabla): los fallos al activar no bloquean el ingreso con contraseña ni la recuperación, y al revés", async () => {
    await beginSecondStepAttempt(USER, "enrollment");
    await recordSecondStepFailure(USER, "enrollment", null);
    await clearSecondStepFailures(USER, "enrollment");
    await beginSecondStepAttempt(USER, "password");
    await beginSecondStepAttempt(USER, "recovery");
    const keys = calls().map(([, scope, key]) => `${scope}:${key}`);
    expect(keys).toContain(`mfa_verify_user:mfa_verify_user|${USER}|enroll`);
    expect(keys).toContain(`mfa_verify_user_day:mfa_verify_user_day|${USER}|enroll`);
    const enrollment = keys.filter((key) => key.includes("|enroll"));
    const others = keys.filter((key) => !key.includes("|enroll"));
    expect(enrollment.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    for (const key of enrollment) expect(others).not.toContain(key);
    // Las tres familias se distinguen entre sí.
    expect(new Set(keys.filter((key) => key.startsWith("mfa_verify_user:"))).size).toBe(3);
    expect(new Set(calls().map(([, scope]) => scope))).toEqual(
      new Set(["mfa_verify_user_day", "mfa_verify_user"]),
    );
  });

  it("las claves del código no se mezclan con las de la contraseña (login_email) ni con las del restablecer", async () => {
    await beginSecondStepAttempt(USER, "password");
    await recordLoginFailure("ana@ejemplo.test", null);
    const byScope = calls().map(([, scope, key]) => `${scope}:${key}`);
    expect(new Set(byScope).size).toBe(byScope.length);
    expect(
      byScope
        .filter((entry) => entry.includes(USER))
        .every((entry) => !entry.startsWith("login_email")),
    ).toBe(true);
  });

  it("distingue el bloqueo del día (24 h) del de la ventana (15 min)", async () => {
    rpc.mockImplementation(async (name: string, args?: { p_scope: string }) => ({
      data:
        name === "auth_limit_locked_until" && args?.p_scope === "mfa_verify_user_day"
          ? "2026-11-12T00:00:00Z"
          : null,
      error: null,
    }));
    expect(await beginSecondStepAttempt(USER, "password")).toBe("day");
    // Con el día bloqueado ni siquiera se registra un intento en la ventana.
    expect(calls().map(([name]) => name)).toEqual(["auth_limit_locked_until"]);
    rpc.mockReset().mockResolvedValue({ data: null, error: null });
    rpc.mockImplementation(async (name: string) => ({
      data: name === "auth_limit_record_failure" ? "2026-11-11T20:00:00Z" : null,
      error: null,
    }));
    expect(await beginSecondStepAttempt(USER, "password")).toBe("short");
  });

  it("los intentos en paralelo no pasan de 5: cada uno se registra en la base, que los cuenta de a uno", async () => {
    // La base responde como `auth_limit_record_failure`: bloquea el intento número 6 y los que siguen.
    let seen = 0;
    rpc.mockImplementation(async (name: string) => {
      if (name !== "auth_limit_record_failure") return { data: null, error: null };
      seen += 1;
      return {
        data: seen > MFA_MAX_ATTEMPTS_PER_ACCOUNT ? "2026-11-11T20:00:00Z" : null,
        error: null,
      };
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => beginSecondStepAttempt(USER, "password")),
    );
    expect(results.filter((result) => result === "none")).toHaveLength(
      MFA_MAX_ATTEMPTS_PER_ACCOUNT,
    );
    expect(results.filter((result) => result === "short")).toHaveLength(
      12 - MFA_MAX_ATTEMPTS_PER_ACCOUNT,
    );
  });

  it("un código incorrecto suma al tope del día de ese camino y al de la IP (el intento ya se contó al empezar)", async () => {
    await recordSecondStepFailure(USER, "password", IP);
    expect(calls()).toEqual([
      ["auth_limit_record_failure", "mfa_verify_user_day", `mfa_verify_user_day|${USER}`],
      ["auth_limit_record_failure", "login_ip", `login_ip|${IP}`],
    ]);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_max_failures: MFA_MAX_FAILURES_PER_ACCOUNT_PER_DAY,
      p_window_seconds: MFA_DAY_SECONDS,
      p_lock_seconds: MFA_DAY_SECONDS,
    });
  });

  it("sin IP conocida no se limita por IP", async () => {
    await recordSecondStepFailure(USER, "password", null);
    expect(calls().map(([, scope]) => scope)).toEqual(["mfa_verify_user_day"]);
    rpc.mockClear();
    expect(await isSecondStepIpLocked(null)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("isSecondStepIpLocked solo lee el contador de la IP", async () => {
    expect(await isSecondStepIpLocked(IP)).toBe(false);
    expect(calls()).toEqual([["auth_limit_locked_until", "login_ip", `login_ip|${IP}`]]);
    rpc.mockResolvedValue({ data: "2026-11-11T20:00:00Z", error: null });
    expect(await isSecondStepIpLocked(IP)).toBe(true);
  });

  it("si el contador falla, se deja pasar y se avisa (Supabase verifica igual)", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    expect(await beginSecondStepAttempt(USER, "password")).toBe("none");
    expect(await isSecondStepIpLocked(IP)).toBe(false);
    expect(await consumeTotpCode(USER, "123456")).toBe(true);
    await expect(recordSecondStepFailure(USER, "password", IP)).resolves.toBeUndefined();
    await expect(clearSecondStepFailures(USER, "password")).resolves.toBeUndefined();
    await expect(releaseTotpCode(USER, "123456")).resolves.toBeUndefined();
  });

  it("un código correcto limpia los intentos de la ventana de ese camino, no los del día", async () => {
    await clearSecondStepFailures(USER, "password");
    await clearSecondStepFailures(USER, "recovery");
    await clearSecondStepFailures(USER, "enrollment");
    expect(calls()).toEqual([
      ["auth_limit_clear", "mfa_verify_user", `mfa_verify_user|${USER}`],
      ["auth_limit_clear", "mfa_verify_user", `mfa_verify_user|${USER}|recovery`],
      ["auth_limit_clear", "mfa_verify_user", `mfa_verify_user|${USER}|enroll`],
    ]);
  });

  it("tras cambiar la contraseña se limpian los contadores del camino «password» (ventana y día), y NADA del de recuperación ni de la IP", async () => {
    await clearPasswordPathSecondStepCounters(USER);
    expect(calls()).toEqual([
      ["auth_limit_clear", "mfa_verify_user", `mfa_verify_user|${USER}`],
      ["auth_limit_clear", "mfa_verify_user_day", `mfa_verify_user_day|${USER}`],
    ]);
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/recovery|enroll|login_ip/);
  });

  it("si limpiar falla, se avisa y no se corta el cambio de contraseña", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    await expect(clearPasswordPathSecondStepCounters(USER)).resolves.toBeUndefined();
  });

  it("consumeTotpCode: el primero pasa; el mismo código otra vez queda bloqueado; la clave es una huella", async () => {
    expect(await consumeTotpCode(USER, "123456")).toBe(true);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_scope: "mfa_code_used",
      p_key_hash: `mfa_code_used|${USER}|123456`,
      p_max_failures: MFA_CODE_REGISTRATIONS_TO_BLOCK,
      p_window_seconds: MFA_CODE_REUSE_SECONDS,
      p_lock_seconds: MFA_CODE_REUSE_SECONDS,
    });
    rpc.mockResolvedValue({ data: "2026-11-11T20:00:00Z", error: null });
    expect(await consumeTotpCode(USER, "123456")).toBe(false);
    expect(MFA_CODE_REUSE_SECONDS).toBe(120);
  });

  it("releaseTotpCode libera EXACTAMENTE la clave de ese código para esa cuenta", async () => {
    await releaseTotpCode(USER, "123456");
    expect(calls()).toEqual([
      ["auth_limit_clear", "mfa_code_used", `mfa_code_used|${USER}|123456`],
    ]);
  });

  it("un código distinto de la misma cuenta, o el mismo de otra cuenta, tienen otra clave", async () => {
    await consumeTotpCode(USER, "123456");
    await consumeTotpCode(USER, "654321");
    await consumeTotpCode("22222222-2222-4222-8222-222222222222", "123456");
    const keys = rpc.mock.calls.map(([, args]) => args.p_key_hash);
    expect(new Set(keys).size).toBe(3);
  });
});
