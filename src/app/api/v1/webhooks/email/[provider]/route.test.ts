import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordDeliveryEvent, loadEmailConfig } = vi.hoisted(() => ({
  recordDeliveryEvent: vi.fn(),
  loadEmailConfig: vi.fn(),
}));
vi.mock("@/lib/email/delivery-events-service", () => ({ recordDeliveryEvent }));
vi.mock("@/lib/email/config", () => ({ loadEmailConfig }));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn() }));

import { signWebhookPayload } from "@/lib/email/delivery-events";
import { POST } from "./route";

const SECRET = "whsec_" + Buffer.from("secreto-de-prueba-1234567890").toString("base64");
const URL_ = "http://localhost/api/v1/webhooks/email/resend";

const body = JSON.stringify({
  type: "email.bounced",
  created_at: new Date().toISOString(),
  data: { email_id: "re_123", bounce: { type: "Permanent" } },
});

function signedRequest(rawBody = body, overrides: Record<string, string> = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  return new Request(URL_, {
    method: "POST",
    body: rawBody,
    headers: {
      "svix-id": "msg_1",
      "svix-timestamp": String(timestamp),
      "svix-signature": signWebhookPayload(SECRET, "msg_1", timestamp, rawBody),
      ...overrides,
    },
  });
}

const call = (request: Request, provider = "resend") =>
  POST(request, { params: Promise.resolve({ provider }) } as never);

beforeEach(() => {
  recordDeliveryEvent.mockReset();
  loadEmailConfig.mockReset().mockReturnValue({ webhookSecret: SECRET });
});

describe("POST /api/v1/webhooks/email/[provider] (H-033)", () => {
  it("sin cabeceras de firma: 401 y no toca la base", async () => {
    const response = await call(new Request(URL_, { method: "POST", body }));
    expect(response.status).toBe(401);
    expect(recordDeliveryEvent).not.toHaveBeenCalled();
  });

  it("firma falsa o cuerpo alterado: 401 y no toca la base", async () => {
    const forged = await call(signedRequest(body, { "svix-signature": "v1,AAAA" }));
    expect(forged.status).toBe(401);
    const good = signedRequest();
    const tampered = new Request(URL_, {
      method: "POST",
      body: body.replace("re_123", "re_999"),
      headers: good.headers,
    });
    expect((await call(tampered)).status).toBe(401);
    expect(recordDeliveryEvent).not.toHaveBeenCalled();
  });

  it("sin secreto configurado ningún aviso se acepta", async () => {
    loadEmailConfig.mockReturnValue({ webhookSecret: null });
    expect((await call(signedRequest())).status).toBe(401);
    loadEmailConfig.mockImplementation(() => {
      throw new Error("config");
    });
    expect((await call(signedRequest())).status).toBe(401);
    expect(recordDeliveryEvent).not.toHaveBeenCalled();
  });

  it("proveedor desconocido: 404", async () => {
    expect((await call(signedRequest(), "otro")).status).toBe(404);
    expect(recordDeliveryEvent).not.toHaveBeenCalled();
  });

  it("aviso válido: lo anota y responde 200", async () => {
    recordDeliveryEvent.mockResolvedValue("applied");
    const response = await call(signedRequest());
    expect(response.status).toBe(200);
    expect(recordDeliveryEvent).toHaveBeenCalledTimes(1);
    expect(recordDeliveryEvent.mock.calls[0][0]).toBe("resend");
    expect(recordDeliveryEvent.mock.calls[0][1]).toMatchObject({
      providerMessageId: "re_123",
      event: "bounced",
      bounceType: "hard",
    });
  });

  it("un aviso que no cambia nada (repetido o viejo) también responde 200", async () => {
    recordDeliveryEvent.mockResolvedValue("ignored");
    expect((await call(signedRequest())).status).toBe(200);
  });

  it("aviso antes de confirmar el envío: 503 con Retry-After, para que el proveedor reintente", async () => {
    recordDeliveryEvent.mockResolvedValue("unknown");
    const response = await call(signedRequest());
    expect(response.status).toBe(503);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("si la base falla: 503 recuperable, nunca 200", async () => {
    recordDeliveryEvent.mockRejectedValue(new Error("delivery_event:XX000"));
    const response = await call(signedRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).not.toBeNull();
  });

  it("tipos de aviso que no usamos se ignoran con 200 y cuerpos rotos dan 400", async () => {
    const other = JSON.stringify({ type: "email.opened", data: {} });
    expect((await call(signedRequest(other))).status).toBe(200);
    expect((await call(signedRequest("no es json"))).status).toBe(400);
    expect(recordDeliveryEvent).not.toHaveBeenCalled();
  });

  it("un cuerpo declarado demasiado grande se rechaza sin leerlo", async () => {
    const response = await call(
      signedRequest(body, { "content-length": String(10 * 1024 * 1024) }),
    );
    expect(response.status).toBe(413);
  });
});
