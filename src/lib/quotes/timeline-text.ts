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

export function describeQuoteEvent(type: string): string {
  return EVENT_TEXTS[type] ?? UNKNOWN_EVENT_TEXT;
}
