import "server-only";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { latestDeliveryByQuote, type EmailDeliveryRow, type QuoteDelivery } from "./delivery-model";

/** Tope de correos que se leen para la lista (50 cotizaciones, con reenvíos de sobra). */
const DELIVERY_ROWS_LIMIT = 1000;

/**
 * Estado de entrega del ÚLTIMO correo de cada cotización (la base lo deja en `email_messages`; solo
 * lee, nunca descifra la dirección). Los intentos que nunca salieron (`pending`, `failed`) no cuentan.
 * Quien no puede ver una cotización tampoco ve sus correos: la política de la tabla lo exige.
 */
export async function getDeliveryByQuote(
  active: ActiveTenant,
  quoteIds: string[],
): Promise<Map<string, QuoteDelivery>> {
  if (quoteIds.length === 0) return new Map();
  const { data, error } = await active.supabase
    .from("email_messages")
    .select("quote_id, status, status_at, created_at")
    .eq("tenant_id", active.tenantId)
    .in("quote_id", quoteIds)
    .in("kind", ["quote", "quote_resend"])
    .in("status", ["sent", "delivered", "bounced", "complained"])
    .order("created_at", { ascending: false })
    .limit(DELIVERY_ROWS_LIMIT);
  if (error || !data) {
    await serverLog("error", "quote_delivery_failed", { code: error?.code });
    return new Map();
  }
  return latestDeliveryByQuote(data as EmailDeliveryRow[]);
}

/** Entrega del último correo de una cotización, o `null` si todavía no salió ninguno. */
export async function getQuoteDelivery(
  active: ActiveTenant,
  quoteId: string,
): Promise<QuoteDelivery | null> {
  return (await getDeliveryByQuote(active, [quoteId])).get(quoteId) ?? null;
}
