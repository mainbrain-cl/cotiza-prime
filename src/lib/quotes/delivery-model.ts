/** Entrega del correo de una cotización: tipos y reglas puras (sin base de datos). */

export const DELIVERY_STATUSES = ["sent", "delivered", "bounced", "complained"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export type QuoteDelivery = {
  status: DeliveryStatus;
  /** Cuándo cambió por última vez el estado de entrega. */
  statusAt: string;
};

export type EmailDeliveryRow = {
  quote_id: string;
  status: string;
  status_at: string;
  created_at: string;
};

const isDeliveryStatus = (value: string): value is DeliveryStatus =>
  (DELIVERY_STATUSES as readonly string[]).includes(value);

/**
 * De varios correos de la misma cotización, gana el MÁS RECIENTE: si el correo rebotó, se corrigió
 * la dirección y se reenvió, el aviso de rebote del primero deja de mostrarse. Las filas pueden
 * llegar en cualquier orden.
 */
export function latestDeliveryByQuote(rows: EmailDeliveryRow[]): Map<string, QuoteDelivery> {
  const newest = new Map<string, EmailDeliveryRow>();
  for (const row of rows) {
    if (!isDeliveryStatus(row.status)) continue;
    const current = newest.get(row.quote_id);
    if (!current || Date.parse(row.created_at) > Date.parse(current.created_at)) {
      newest.set(row.quote_id, row);
    }
  }
  const result = new Map<string, QuoteDelivery>();
  for (const [quoteId, row] of newest) {
    result.set(quoteId, { status: row.status as DeliveryStatus, statusAt: row.status_at });
  }
  return result;
}

/** Un correo rebotado (o marcado como spam) es el que el equipo tiene que atender. */
export const needsAttention = (delivery: QuoteDelivery | null | undefined): boolean =>
  delivery?.status === "bounced" || delivery?.status === "complained";
