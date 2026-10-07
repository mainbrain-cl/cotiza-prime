import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin-client", () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn() }));
vi.mock("@/lib/crypto/search-hash", () => ({
  // Huella legible para comprobar qué se está contando
  searchHash: (field: string, _tenant: string, value: string) => `${field}|${value}`,
}));

import {
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
