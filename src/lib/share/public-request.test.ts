import { beforeEach, describe, expect, it, vi } from "vitest";

const consumeShareQuota = vi.fn();
vi.mock("@/lib/security/login-rate-limit", () => ({
  consumeShareQuota: (...args: unknown[]) => consumeShareQuota(...args),
}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn() }));
vi.mock("@/lib/http/request-context", () => ({
  getAppOrigin: () => "https://app.ejemplo.test",
  getRequestContext: async () => ({ requestId: "r", clientIp: "203.0.113.7", userAgent: "x" }),
}));

import {
  PUBLIC_RESPONSE_HEADERS,
  isSameOriginPost,
  passTokenGate,
  tooManyRequests,
} from "./public-request";
import { hashShareToken, newShareToken } from "./token";

beforeEach(() => consumeShareQuota.mockReset().mockResolvedValue(true));

const post = (origin?: string) =>
  new Request("https://app.ejemplo.test/x", {
    method: "POST",
    headers: origin ? { origin } : {},
  });

describe("comprobación del Origin en los POST públicos", () => {
  it("acepta solo el origen de la aplicación", () => {
    expect(isSameOriginPost(post("https://app.ejemplo.test"))).toBe(true);
    expect(isSameOriginPost(post("https://malo.test"))).toBe(false);
    expect(isSameOriginPost(post("https://app.ejemplo.test.malo.test"))).toBe(false);
    expect(isSameOriginPost(post("http://app.ejemplo.test"))).toBe(false);
    expect(isSameOriginPost(post("no es una url"))).toBe(false);
    expect(isSameOriginPost(post())).toBe(false);
  });
});

describe("las puertas del token", () => {
  it("un token mal formado se rechaza antes de gastar el límite o tocar la base", async () => {
    expect(await passTokenGate("corto")).toEqual({ ok: false, reason: "malformed" });
    expect(consumeShareQuota).not.toHaveBeenCalled();
  });

  it("cuenta con la IP del servidor y el sello del token", async () => {
    const token = newShareToken();
    expect(await passTokenGate(token)).toEqual({ ok: true, tokenSha256: hashShareToken(token) });
    expect(consumeShareQuota).toHaveBeenCalledWith("203.0.113.7", hashShareToken(token));
  });

  it("pasado el límite, responde que hay demasiadas solicitudes", async () => {
    consumeShareQuota.mockResolvedValue(false);
    expect(await passTokenGate(newShareToken())).toEqual({ ok: false, reason: "rate_limited" });
    const response = tooManyRequests();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });
});

describe("cabeceras de toda respuesta pública", () => {
  it("no se guarda en cachés, no se indexa y no se manda la dirección al salir", () => {
    expect(PUBLIC_RESPONSE_HEADERS["Cache-Control"]).toBe("private, no-store");
    expect(PUBLIC_RESPONSE_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    expect(PUBLIC_RESPONSE_HEADERS["X-Robots-Tag"]).toBe("noindex, nofollow");
  });
});
