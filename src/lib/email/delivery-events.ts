/**
 * Avisos de entrega del proveedor de correo (entregado, rebotado, queja). Funciones puras: la ruta
 * HTTP `/api/v1/webhooks/email/[provider]` las usa para verificar la firma y normalizar el evento.
 *
 * La firma sigue el esquema Svix (el que usa Resend): HMAC-SHA256 de `id.timestamp.cuerpo` con el
 * secreto, y una cabecera con una o más firmas `v1,<base64>`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type DeliveryEventKind = "delivered" | "bounced" | "complained";
export type BounceType = "hard" | "soft" | "unknown";

export type DeliveryEvent = {
  providerMessageId: string;
  event: DeliveryEventKind;
  occurredAt: Date;
  /** Solo para `bounced`. */
  bounceType: BounceType | null;
};

/** Tolerancia entre la hora del aviso y la nuestra: frena la repetición de avisos viejos. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 200;

function signingKey(secret: string): Buffer {
  return secret.startsWith(SECRET_PREFIX)
    ? Buffer.from(secret.slice(SECRET_PREFIX.length), "base64")
    : Buffer.from(secret, "utf8");
}

/** Firma un aviso (la usan las pruebas y la simulación; el proveedor real firma por su lado). */
export function signWebhookPayload(
  secret: string,
  id: string,
  timestampSeconds: number,
  body: string,
): string {
  const digest = createHmac("sha256", signingKey(secret))
    .update(`${id}.${timestampSeconds}.${body}`)
    .digest("base64");
  return `${SIGNATURE_VERSION},${digest}`;
}

export type WebhookHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

/** Verifica la firma en tiempo constante y que el aviso no sea demasiado viejo ni del futuro. */
export function verifyWebhookSignature(params: {
  secret: string;
  headers: WebhookHeaders;
  body: string;
  nowMs?: number;
}): boolean {
  const { secret, headers, body } = params;
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  if (id.length > MAX_ID_LENGTH || Buffer.byteLength(body) > MAX_BODY_BYTES) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;

  const nowSeconds = Math.floor((params.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(
    signWebhookPayload(secret, id, Number(timestamp), body).slice(SIGNATURE_VERSION.length + 1),
    "base64",
  );
  let valid = false;
  for (const candidate of signature.split(" ")) {
    const [version, value] = candidate.split(",");
    if (version !== SIGNATURE_VERSION || !value) continue;
    const received = Buffer.from(value, "base64");
    // Se evalúan todas (sin cortar) para que el tiempo no delate cuál coincidió.
    if (received.length === expected.length && timingSafeEqual(received, expected)) valid = true;
  }
  return valid;
}

export type ParsedDeliveryEvent =
  { kind: "event"; event: DeliveryEvent } | { kind: "ignored" } | { kind: "invalid" };

const RESEND_EVENT_TYPES: Record<string, DeliveryEventKind> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

const RESEND_BOUNCE_TYPES: Record<string, BounceType> = {
  permanent: "hard",
  transient: "soft",
  undetermined: "unknown",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Normaliza el cuerpo (ya verificado) de un aviso de Resend. Tipos que no usamos → `ignored`. */
export function parseResendEvent(rawBody: string): ParsedDeliveryEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(payload) || typeof payload.type !== "string") return { kind: "invalid" };

  const event = RESEND_EVENT_TYPES[payload.type];
  if (!event) return { kind: "ignored" };

  const data = payload.data;
  if (!isRecord(data)) return { kind: "invalid" };
  const providerMessageId = data.email_id;
  if (
    typeof providerMessageId !== "string" ||
    providerMessageId.length === 0 ||
    providerMessageId.length > MAX_ID_LENGTH
  ) {
    return { kind: "invalid" };
  }

  const occurredAt = new Date(
    typeof payload.created_at === "string" ? payload.created_at : Number.NaN,
  );
  if (Number.isNaN(occurredAt.getTime())) return { kind: "invalid" };

  let bounceType: BounceType | null = null;
  if (event === "bounced") {
    const bounce = isRecord(data.bounce) ? data.bounce : {};
    const type = typeof bounce.type === "string" ? bounce.type.toLowerCase() : "";
    bounceType = RESEND_BOUNCE_TYPES[type] ?? "unknown";
  }
  return { kind: "event", event: { providerMessageId, event, occurredAt, bounceType } };
}

export type WebhookVerification =
  | { ok: true; parsed: ParsedDeliveryEvent }
  | { ok: false; code: "bad_signature" | "unsupported_provider" };

/**
 * Punto de entrada para la ruta HTTP: verifica la firma y, solo si es válida, interpreta el
 * cuerpo. Sin firma válida no se mira el contenido.
 */
export function verifyAndParseWebhook(params: {
  provider: string;
  secret: string | null;
  headers: WebhookHeaders;
  body: string;
  nowMs?: number;
}): WebhookVerification {
  if (params.provider !== "resend") return { ok: false, code: "unsupported_provider" };
  if (!params.secret) return { ok: false, code: "bad_signature" };
  if (!verifyWebhookSignature({ ...params, secret: params.secret })) {
    return { ok: false, code: "bad_signature" };
  }
  return { ok: true, parsed: parseResendEvent(params.body) };
}

/** Rebote duro simulado (mailpit/memory, destinatarios `@rebota.ejemplo.test`). */
export function simulatedBounce(providerMessageId: string, now: Date = new Date()): DeliveryEvent {
  return { providerMessageId, event: "bounced", occurredAt: now, bounceType: "hard" };
}
