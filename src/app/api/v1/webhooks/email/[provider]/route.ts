import { loadEmailConfig } from "@/lib/email/config";
import { verifyAndParseWebhook } from "@/lib/email/delivery-events";
import { recordDeliveryEvent } from "@/lib/email/delivery-events-service";
import { serverLog } from "@/lib/log/server-log";
import { publicText } from "@/lib/share/public-request";

export const runtime = "nodejs";

/** Cabeceras de firma del proveedor (esquema Svix, el que usa Resend). */
const HEADER_ID = "svix-id";
const HEADER_TIMESTAMP = "svix-timestamp";
const HEADER_SIGNATURE = "svix-signature";
/** Un aviso real pesa unos cientos de bytes: más que esto se rechaza sin leerlo. */
const MAX_BODY_BYTES = 64 * 1024;
/** Segundos que se le pide esperar al proveedor antes de reintentar un aviso. */
const RETRY_AFTER_SECONDS = 30;

function configuredSecret(): string | null {
  try {
    return loadEmailConfig().webhookSecret;
  } catch {
    // Sin configuración de correo válida no hay secreto: ningún aviso se acepta.
    return null;
  }
}

function retryLater(): Response {
  const response = publicText("Intenta de nuevo más tarde.", 503);
  response.headers.set("Retry-After", String(RETRY_AFTER_SECONDS));
  return response;
}

/**
 * Avisos de entrega del proveedor de correo (H-033). Es una ruta pública protegida por FIRMA, no por
 * token ni por sesión. Orden: (1) tamaño; (2) firma — sin firma válida, 401 y no se mira el cuerpo
 * ni se toca la base; (3) interpretar el aviso; (4) anotarlo con `record_email_event`.
 *
 * Un aviso que llega antes de que el envío quede confirmado (el correo todavía no tiene su
 * identificador) responde 503 con `Retry-After`: el proveedor lo reintenta, no se pierde.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/webhooks/email/[provider]">,
) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return publicText("Aviso demasiado grande.", 413);
  }
  const { provider } = await context.params;
  const body = await request.text();

  const verification = verifyAndParseWebhook({
    provider,
    secret: configuredSecret(),
    headers: {
      id: request.headers.get(HEADER_ID),
      timestamp: request.headers.get(HEADER_TIMESTAMP),
      signature: request.headers.get(HEADER_SIGNATURE),
    },
    body,
  });
  if (!verification.ok) {
    if (verification.code === "unsupported_provider") {
      return publicText("Proveedor no soportado.", 404);
    }
    await serverLog("warn", "email_webhook_bad_signature", { provider });
    return publicText("Firma no válida.", 401);
  }

  const { parsed } = verification;
  if (parsed.kind === "invalid") return publicText("Aviso no válido.", 400);
  if (parsed.kind === "ignored") return publicText("Aviso ignorado.", 200);

  try {
    const result = await recordDeliveryEvent(provider, parsed.event);
    if (result === "unknown") {
      await serverLog("warn", "email_webhook_unknown_message", { provider });
      return retryLater();
    }
    return publicText("Aviso recibido.", 200);
  } catch (error) {
    await serverLog("error", "email_webhook_record_failed", {
      provider,
      code: error instanceof Error ? error.message : "unknown",
    });
    return retryLater();
  }
}
