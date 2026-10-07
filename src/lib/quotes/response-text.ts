import { reasonLabel } from "@/lib/share/respond";

/** La respuesta del cliente, ya descifrada, lista para mostrarla a los miembros de la organización. */
export type QuoteResponseView = {
  decision: "accepted" | "rejected";
  respondedAt: string;
  /** Solo en aceptaciones; `null` si no se pudo descifrar. */
  acceptorName: string | null;
  /** Solo en rechazos: el código de la lista de motivos. */
  reasonCode: string | null;
  /** Detalle escrito por el cliente cuando eligió «otro»; `null` si no hay o no se pudo descifrar. */
  reasonText: string | null;
  /** `true` si había un dato cifrado que no se pudo leer (llave distinta, dato dañado). */
  unreadable: boolean;
};

/** Encabezado de la tarjeta: «Aceptada por Ana Pérez el 05-10-2026» o «Rechazada por el cliente el …». */
export function responseHeadline(response: QuoteResponseView, dateText: string): string {
  if (response.decision === "accepted") {
    return response.acceptorName
      ? `Aceptada por ${response.acceptorName} el ${dateText}`
      : `Aceptada por el cliente el ${dateText}`;
  }
  return `Rechazada por el cliente el ${dateText}`;
}

/** Motivo de un rechazo, con el texto de la lista que ve el cliente. */
export function responseReason(response: QuoteResponseView): string | null {
  return response.decision === "rejected" && response.reasonCode
    ? reasonLabel(response.reasonCode)
    : null;
}
