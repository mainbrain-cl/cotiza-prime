import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";
import type { DeliveryEvent } from "./delivery-events";

/**
 * Servicio mínimo que anota los avisos de entrega (entregado, rebotado, queja) en la base. Es el
 * ÚNICO archivo, junto con el portero del enlace, que usa la llave maestra para algo que no es una
 * petición de una persona con sesión, y llama a UNA sola función de la base: `record_email_event`
 * (ejecutable solo por el servidor). No lee ni escribe ninguna tabla directamente.
 *
 * Lo llaman dos caminos y siempre por esta misma función:
 *  - la ruta `/api/v1/webhooks/email/[provider]`, DESPUÉS de verificar la firma del proveedor;
 *  - el envío, para los avisos simulados de rebote fuera de producción.
 *
 * Nunca se registran correos, identificadores del proveedor ni contenido: solo códigos.
 */

const RECORD_FUNCTION = "record_email_event";
/** La base solo conoce rebote duro o blando: un rebote "indeterminado" se trata como blando. */
const FALLBACK_BOUNCE_TYPE = "soft";

export type RecordDeliveryResult =
  /** El estado del correo avanzó. */
  | "applied"
  /** El aviso no cambia nada (ya estaba en ese estado o más adelante, o es más viejo que el último). */
  | "ignored"
  /** Todavía no existe un correo con ese identificador (el aviso llegó antes de confirmar el envío). */
  | "unknown";

export class DeliveryEventError extends Error {
  constructor(code?: string) {
    super(`delivery_event${code ? `:${code}` : ""}`);
    this.name = "DeliveryEventError";
  }
}

/** Anota un aviso de entrega. Si la base falla, lanza `DeliveryEventError` (solo con el código). */
export async function recordDeliveryEvent(
  provider: string,
  event: DeliveryEvent,
): Promise<RecordDeliveryResult> {
  const bounceType =
    event.event === "bounced"
      ? event.bounceType === "hard"
        ? "hard"
        : event.bounceType === "soft"
          ? "soft"
          : FALLBACK_BOUNCE_TYPE
      : null;
  const { data, error } = await createAdminClient().rpc(RECORD_FUNCTION, {
    p_provider: provider,
    p_provider_message_id: event.providerMessageId,
    p_event: event.event,
    p_occurred_at: event.occurredAt.toISOString(),
    p_bounce_type: bounceType,
  });
  if (error) throw new DeliveryEventError(error.code);
  const result = (data as { result?: unknown } | null)?.result;
  if (result === "applied") return "applied";
  if (result === "unknown") return "unknown";
  if (result === "ignored" || result === "ignored_older") return "ignored";
  throw new DeliveryEventError("shape");
}
