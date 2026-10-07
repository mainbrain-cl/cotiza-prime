import { reasonTeamText } from "@/lib/share/respond";

/** Texto, en español de Chile, de cada tipo de evento de la línea de tiempo de una cotización. */
const EVENT_TEXTS: Record<string, string> = {
  created: "Cotización creada",
  sent: "Enviada al cliente",
  send_failed: "No se pudo enviar el correo al cliente",
  resent: "Reenviada al cliente con un enlace nuevo",
  viewed: "El cliente abrió la cotización",
  accepted: "El cliente aceptó la cotización",
  rejected_by_customer: "El cliente rechazó la cotización",
  expired: "La cotización venció",
  link_revoked: "Se revocó el enlace del cliente",
  email_bounced: "El correo rebotó: no llegó al cliente",
};

export const UNKNOWN_EVENT_TEXT = "Cambio registrado";

/**
 * Texto del evento. El rechazo del cliente agrega el motivo (su código viaja en `data.reason_code`,
 * sin datos personales); el detalle escrito por el cliente queda cifrado y no sale aquí.
 */
export function describeQuoteEvent(type: string, data?: unknown): string {
  const base = EVENT_TEXTS[type] ?? UNKNOWN_EVENT_TEXT;
  if (type !== "rejected_by_customer" || !data || typeof data !== "object") return base;
  const code = (data as { reason_code?: unknown }).reason_code;
  const reason = typeof code === "string" ? reasonTeamText(code) : undefined;
  return reason ? `${base}: ${reason}` : base;
}
