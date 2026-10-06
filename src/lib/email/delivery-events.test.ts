import { describe, expect, it } from "vitest";
import {
  WEBHOOK_TOLERANCE_SECONDS,
  parseResendEvent,
  signWebhookPayload,
  simulatedBounce,
  verifyAndParseWebhook,
  verifyWebhookSignature,
} from "./delivery-events";

const SECRET = "whsec_" + Buffer.from("secreto-de-prueba-1234567890").toString("base64");
const NOW_MS = Date.UTC(2026, 9, 6, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

const bounceBody = JSON.stringify({
  type: "email.bounced",
  created_at: "2026-10-06T11:59:00.000Z",
  data: { email_id: "re_123", bounce: { type: "Permanent" } },
});

function headersFor(body: string, secret = SECRET, ts = NOW_S, id = "msg_1") {
  return { id, timestamp: String(ts), signature: signWebhookPayload(secret, id, ts, body) };
}

describe("verifyWebhookSignature", () => {
  it("acepta una firma correcta", () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        headers: headersFor(bounceBody),
        body: bounceBody,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("acepta varias firmas en la cabecera si una calza", () => {
    const good = headersFor(bounceBody);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        headers: { ...good, signature: `v1,AAAA ${good.signature}` },
        body: bounceBody,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("rechaza cuerpo alterado, secreto distinto, id alterado y firma vacía", () => {
    const good = headersFor(bounceBody);
    const check = (over: object, body = bounceBody, secret = SECRET) =>
      verifyWebhookSignature({ secret, headers: { ...good, ...over }, body, nowMs: NOW_MS });
    expect(check({}, bounceBody + " ")).toBe(false);
    expect(check({}, bounceBody, "otro-secreto-muy-largo-123")).toBe(false);
    expect(check({ id: "msg_2" })).toBe(false);
    expect(check({ signature: "" })).toBe(false);
    expect(check({ signature: null })).toBe(false);
    expect(check({ signature: "v2," + good.signature.slice(3) })).toBe(false);
    expect(check({ signature: "v1,corta" })).toBe(false);
  });

  it("rechaza avisos viejos o del futuro", () => {
    const old = NOW_S - WEBHOOK_TOLERANCE_SECONDS - 1;
    const future = NOW_S + WEBHOOK_TOLERANCE_SECONDS + 1;
    for (const ts of [old, future]) {
      expect(
        verifyWebhookSignature({
          secret: SECRET,
          headers: headersFor(bounceBody, SECRET, ts),
          body: bounceBody,
          nowMs: NOW_MS,
        }),
      ).toBe(false);
    }
  });

  it("rechaza marcas de tiempo mal formadas", () => {
    const h = headersFor(bounceBody);
    for (const timestamp of ["abc", "-5", "1e9", "", " 1"]) {
      expect(
        verifyWebhookSignature({
          secret: SECRET,
          headers: { ...h, timestamp },
          body: bounceBody,
          nowMs: NOW_MS,
        }),
      ).toBe(false);
    }
  });

  it("nunca acepta con secreto vacío", () => {
    expect(
      verifyWebhookSignature({
        secret: "",
        headers: headersFor(bounceBody, ""),
        body: bounceBody,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });
});

describe("parseResendEvent", () => {
  it("normaliza rebote duro, blando y desconocido", () => {
    const parse = (type?: string) =>
      parseResendEvent(
        JSON.stringify({
          type: "email.bounced",
          created_at: "2026-10-06T11:59:00.000Z",
          data: { email_id: "re_1", ...(type ? { bounce: { type } } : {}) },
        }),
      );
    expect(parse("Permanent")).toEqual({
      kind: "event",
      event: {
        providerMessageId: "re_1",
        event: "bounced",
        occurredAt: new Date("2026-10-06T11:59:00.000Z"),
        bounceType: "hard",
      },
    });
    expect(parse("Transient")).toMatchObject({ event: { bounceType: "soft" } });
    expect(parse("Undetermined")).toMatchObject({ event: { bounceType: "unknown" } });
    expect(parse()).toMatchObject({ event: { bounceType: "unknown" } });
  });

  it("normaliza entregado y queja, sin tipo de rebote", () => {
    for (const [type, event] of [
      ["email.delivered", "delivered"],
      ["email.complained", "complained"],
    ] as const) {
      expect(
        parseResendEvent(
          JSON.stringify({ type, created_at: "2026-10-06T11:59:00Z", data: { email_id: "re_2" } }),
        ),
      ).toMatchObject({ kind: "event", event: { event, bounceType: null } });
    }
  });

  it("ignora tipos que no usamos y marca inválido lo mal formado", () => {
    expect(parseResendEvent(JSON.stringify({ type: "email.opened", data: {} }))).toEqual({
      kind: "ignored",
    });
    for (const bad of [
      "no json",
      "[]",
      "null",
      JSON.stringify({ type: "email.delivered" }),
      JSON.stringify({ type: "email.delivered", created_at: "x", data: { email_id: "a" } }),
      JSON.stringify({
        type: "email.delivered",
        created_at: "2026-10-06T00:00:00Z",
        data: { email_id: 5 },
      }),
    ]) {
      expect(parseResendEvent(bad), bad).toEqual({ kind: "invalid" });
    }
  });
});

describe("verifyAndParseWebhook", () => {
  it("sin firma válida no interpreta el cuerpo", () => {
    expect(
      verifyAndParseWebhook({
        provider: "resend",
        secret: SECRET,
        headers: { id: "a", timestamp: String(NOW_S), signature: "v1,x" },
        body: bounceBody,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, code: "bad_signature" });
  });

  it("sin secreto configurado rechaza todo", () => {
    expect(
      verifyAndParseWebhook({
        provider: "resend",
        secret: null,
        headers: headersFor(bounceBody),
        body: bounceBody,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, code: "bad_signature" });
  });

  it("proveedor desconocido", () => {
    expect(
      verifyAndParseWebhook({
        provider: "otro",
        secret: SECRET,
        headers: headersFor(bounceBody),
        body: bounceBody,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, code: "unsupported_provider" });
  });

  it("firma válida entrega el evento normalizado", () => {
    const result = verifyAndParseWebhook({
      provider: "resend",
      secret: SECRET,
      headers: headersFor(bounceBody),
      body: bounceBody,
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({
      ok: true,
      parsed: { kind: "event", event: { providerMessageId: "re_123" } },
    });
  });
});

describe("simulatedBounce", () => {
  it("es un rebote duro", () => {
    expect(simulatedBounce("m1")).toMatchObject({
      providerMessageId: "m1",
      event: "bounced",
      bounceType: "hard",
    });
  });
});
