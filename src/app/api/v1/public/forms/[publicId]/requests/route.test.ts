import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handleIntakeSubmit: vi.fn() }));

vi.mock("@/lib/intake/submit-service", () => ({ handleIntakeSubmit: mocks.handleIntakeSubmit }));
vi.mock("@/lib/http/request-context", () => ({
  getAppOrigin: () => "https://app.ejemplo.test",
  getRequestContext: async () => ({ requestId: "r", clientIp: "203.0.113.9", userAgent: "UA" }),
}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn() }));
vi.mock("@/lib/security/login-rate-limit", () => ({ consumeShareQuota: vi.fn() }));

import { POST } from "./route";

const PUBLIC_ID = "A".repeat(22);
const context = { params: Promise.resolve({ publicId: PUBLIC_ID }) } as never;
const post = (origin?: string) =>
  new Request("https://app.ejemplo.test/api/v1/public/forms/x/requests", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: "{}",
  });

beforeEach(() => mocks.handleIntakeSubmit.mockReset().mockResolvedValue(new Response("ok")));

describe("POST /api/v1/public/forms/[publicId]/requests", () => {
  it("sin Origin o con un Origin ajeno responde 403 sin llamar a nada más", async () => {
    for (const origin of [undefined, "https://malo.test", "http://app.ejemplo.test"]) {
      const response = await POST(post(origin), context);
      expect(response.status, String(origin)).toBe(403);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toBe("Solicitud no permitida.");
    }
    expect(mocks.handleIntakeSubmit).not.toHaveBeenCalled();
  });

  it("con el Origin de la aplicación pasa el identificador al servicio", async () => {
    const response = await POST(post("https://app.ejemplo.test"), context);
    expect(response.status).toBe(200);
    expect(mocks.handleIntakeSubmit).toHaveBeenCalledOnce();
    expect(mocks.handleIntakeSubmit.mock.calls[0][1]).toBe(PUBLIC_ID);
  });

  it("no define respuestas de CORS", async () => {
    const response = await POST(post("https://malo.test"), context);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
