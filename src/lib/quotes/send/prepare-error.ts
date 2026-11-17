import { approvalPrepareError } from "@/lib/approvals/send-block";
import { lineRulesPrepareError } from "@/lib/quotes/line-rules-block";

/**
 * Cómo se lee un error de `prepare_quote_send` (la base congela lo que se envía y toma el candado). Vive aparte de las acciones
 * de envío porque un archivo `use server` solo puede exportar funciones y estos textos y esta lectura se prueban sin base de datos.
 */

export const SQLSTATE_FORBIDDEN = "42501";
export const SQLSTATE_NOT_FOUND = "CP404";
export const SQLSTATE_CONFLICT = "CP409";
export const SQLSTATE_INVALID = "CP422";
export const SQLSTATE_NOT_ALLOWED = "CP423";

export const MSG_NOT_FOUND = "No encontramos esta cotización.";
export const MSG_FORBIDDEN_SEND = "Solo quien creó esta cotización puede enviarla.";
export const MSG_NOT_DRAFT =
  "Esta cotización ya no está en borrador, así que no se puede enviar de nuevo.";
export const MSG_NO_LINES = "Agrega al menos una línea a la cotización antes de enviarla.";
export const MSG_ANONYMIZED = "Este cliente ya no está disponible. Elige otro en la cotización.";
export const MSG_VALIDITY_PAST = "La vigencia de la cotización ya pasó. Cambia la fecha y guarda.";
export const MSG_CHANGED =
  "La cotización cambió mientras la enviabas. Recarga la página y revísala.";
export const MSG_IN_PROGRESS_OTHER = "Esta cotización ya se está enviando. Espera unos segundos.";
export const MSG_UNEXPECTED = "No pudimos enviar la cotización. Intenta de nuevo en unos minutos.";

export type PrepareSupabaseError = { code?: string; message?: string; details?: string | null };

/**
 * Esperados (no son un fallo nuestro, no se registran como advertencia del servidor): choque de revisión o de envío, falta de
 * permiso, la regla de aprobación (H-040b) y las reglas de precio y descuento (H-041).
 */
export function isExpectedPrepareError(error: PrepareSupabaseError): boolean {
  const message = error.message ?? "";
  return (
    error.code === SQLSTATE_CONFLICT ||
    error.code === SQLSTATE_FORBIDDEN ||
    (error.code === SQLSTATE_NOT_ALLOWED && message.startsWith("approval_required")) ||
    (error.code === SQLSTATE_INVALID && message.startsWith("line_rules_invalid"))
  );
}

export function prepareErrorMessage(error: PrepareSupabaseError): string {
  const message = error.message ?? "";
  switch (error.code) {
    case SQLSTATE_FORBIDDEN:
      return MSG_FORBIDDEN_SEND;
    case SQLSTATE_NOT_FOUND:
      return MSG_NOT_FOUND;
    case SQLSTATE_NOT_ALLOWED:
      // La regla de aprobación (H-040b) rechaza con el mismo código que "ya no está en borrador": se distingue por el
      // motivo, y ANTES del mensaje general.
      return approvalPrepareError(message, error.details) ?? MSG_NOT_DRAFT;
    case SQLSTATE_CONFLICT:
      return message.startsWith("send_in_progress") ? MSG_IN_PROGRESS_OTHER : MSG_CHANGED;
    case SQLSTATE_INVALID:
      // Las reglas de precio y descuento (H-041) rechazan con CP422 y la lista de problemas en el mensaje.
      if (message.startsWith("line_rules_invalid")) {
        return lineRulesPrepareError(message) ?? MSG_UNEXPECTED;
      }
      if (message.startsWith("no_lines")) return MSG_NO_LINES;
      if (message.startsWith("customer_anonymized")) return MSG_ANONYMIZED;
      if (message.startsWith("validity_past")) return MSG_VALIDITY_PAST;
      return MSG_UNEXPECTED;
    default:
      return MSG_UNEXPECTED;
  }
}
