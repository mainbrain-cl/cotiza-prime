import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  respondToShare: vi.fn(),
  onQuoteResponded: vi.fn(),
  consumeShareRespondQuota: vi.fn(),
  serverLog: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/http/request-context", () => ({
  getRequestContext: async () => ({ requestId: "r", clientIp: "203.0.113.9", userAgent: "UA" }),
  getAppOrigin: () => "http://localhost:3000",
}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: mocks.serverLog }));
vi.mock("@/lib/security/login-rate-limit", () => ({
  consumeShareRespondQuota: mocks.consumeShareRespondQuota,
  consumeShareQuota: vi.fn(),
}));
vi.mock("./respond-service", () => ({ respondToShare: mocks.respondToShare }));
vi.mock("./after-response", () => ({ onQuoteResponded: mocks.onQuoteResponded }));
vi.mock("@/lib/supabase/admin-client", () => ({ createAdminClient: vi.fn() }));

import { ShareGatewayError } from "./gateway";
import { readJsonBody, respondFromRequest } from "./respond-request";
import { RESPOND_BODY_MAX_BYTES } from "./respond";

const KEY = "0b0f6a6e-3c3e-4a4f-9b8c-1d2e3f4a5b6c";
const TOKEN = "t".repeat(43);

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const accept = { responseKey: KEY, name: "Ana Prueba", confirmed: true };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.consumeShareRespondQuota.mockResolvedValue(true);
});

describe("cuerpo de la respuesta, leído por partes", () => {
  it("un JSON chico se lee", async () => {
    expect(await readJsonBody(post({ a: 1 }))).toEqual({ a: 1 });
  });

  it("corta apenas pasa los 4 KB aunque no declare el tamaño", async () => {
    const encoder = new TextEncoder();
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1_024;
        controller.enqueue(encoder.encode("x".repeat(1_024)));
        if (sent > 1_000_000) controller.close();
      },
    });
    const request = new Request("http://localhost:3000/x", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(await readJsonBody(request)).toBeUndefined();
    expect(sent).toBeLessThan(RESPOND_BODY_MAX_BYTES * 4);
  });

  it("un Content-Length que ya pasa el tope se rechaza sin leer", async () => {
    const request = post({ a: 1 }, { "content-length": String(RESPOND_BODY_MAX_BYTES + 1) });
    expect(await readJsonBody(request)).toBeUndefined();
  });

  it("texto que no es JSON no es un cuerpo válido", async () => {
    expect(await readJsonBody(post("{no es json"))).toBeUndefined();
  });
});

describe("respuesta del cliente por la ruta (H-031)", () => {
  it("cuerpo ilegible: 422 sin tocar el límite ni la base", async () => {
    const response = await respondFromRequest(post("no json"), TOKEN, "accepted");
    expect(response.status).toBe(422);
    expect(mocks.respondToShare).not.toHaveBeenCalled();
    expect(mocks.consumeShareRespondQuota).not.toHaveBeenCalled();
  });

  it("campos inválidos: 422 con el error por campo", async () => {
    const response = await respondFromRequest(
      post({ responseKey: KEY, name: "", confirmed: false }),
      TOKEN,
      "accepted",
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.status).toBe("invalid");
    expect(body.fieldErrors).toHaveProperty("name");
    expect(body.fieldErrors).toHaveProperty("confirmed");
    expect(mocks.respondToShare).not.toHaveBeenCalled();
  });

  it("pasado el límite por IP: 429 con Retry-After", async () => {
    mocks.consumeShareRespondQuota.mockResolvedValue(false);
    const response = await respondFromRequest(post(accept), TOKEN, "accepted");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3600");
    expect(mocks.respondToShare).not.toHaveBeenCalled();
  });

  it("ok: 200, y el aviso al equipo se programa para DESPUÉS de responder", async () => {
    const notify = { tenantId: "t", quoteId: "q" };
    mocks.respondToShare.mockResolvedValue({
      outcome: { status: "ok", decision: "accepted" },
      notify,
    });
    const response = await respondFromRequest(post(accept), TOKEN, "accepted");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", decision: "accepted" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.onQuoteResponded).not.toHaveBeenCalled();
    mocks.after.mock.calls[0][0]();
    expect(mocks.onQuoteResponded).toHaveBeenCalledWith(notify);
  });

  it("sin aviso que hacer (repetido o ya respondida) no se programa nada", async () => {
    mocks.respondToShare.mockResolvedValue({
      outcome: { status: "already_responded", decision: "rejected" },
      notify: null,
    });
    const response = await respondFromRequest(post(accept), TOKEN, "accepted");
    expect(response.status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("cotización reemplazada: 409; enlace inexistente: 404", async () => {
    mocks.respondToShare.mockResolvedValue({
      outcome: { status: "unavailable", reason: "superseded" },
      notify: null,
    });
    const superseded = await respondFromRequest(post(accept), TOKEN, "accepted");
    expect(superseded.status).toBe(409);
    expect(await superseded.json()).toEqual({ status: "unavailable", reason: "superseded" });

    mocks.respondToShare.mockResolvedValue({
      outcome: { status: "unavailable", reason: "not_found" },
      notify: null,
    });
    expect((await respondFromRequest(post(accept), TOKEN, "accepted")).status).toBe(404);
  });

  it("un error de la base se anota solo con su código y responde 500", async () => {
    mocks.respondToShare.mockRejectedValue(new ShareGatewayError("respond", "42501"));
    const response = await respondFromRequest(post(accept), TOKEN, "accepted");
    expect(response.status).toBe(500);
    expect(mocks.serverLog).toHaveBeenCalledWith("error", "share_respond_failed", {
      code: "share_gateway_respond:42501",
    });
  });

  it("un error inesperado se anota como «unexpected», sin su mensaje", async () => {
    mocks.respondToShare.mockRejectedValue(new Error("detalle con ana@ejemplo.test"));
    const response = await respondFromRequest(post(accept), TOKEN, "accepted");
    expect(response.status).toBe(500);
    expect(mocks.serverLog).toHaveBeenCalledWith("error", "share_respond_failed", {
      code: "unexpected",
    });
    expect(JSON.stringify(mocks.serverLog.mock.calls)).not.toContain("ana@ejemplo.test");
  });
});
