import { describeApprovalReasons } from "./describe";
import { approvalMetrics, approvalReasons, type ApprovalRule, type ApprovalTotals } from "./rule";

/**
 * El bloqueo de `/enviar` cuando la regla de la organización pide aprobación (H-040b). Lo calcula la función de TypeScript con
 * los totales GUARDADOS de la cotización; el servidor lo vuelve a decidir en la base de datos al enviar (disparador
 * `quote_packages_approval_gate`), aunque la petición llegue sin pasar por la pantalla.
 *
 * Mientras no exista «Solicitar aprobación» (sprint 6) la frase lo dice con claridad: lo que cumple la regla no sale.
 */
export const APPROVAL_NOT_AVAILABLE_YET =
  "La solicitud de aprobación todavía no está disponible; ajusta la cotización o pide a quien administra la organización que revise la regla.";

/**
 * Con «Siempre» ninguna cotización puede salir hasta que exista la solicitud de aprobación (sprint 6): ajustar la cotización no
 * sirve de nada, así que no se sugiere. Se dice la verdad: hoy no puede enviarse.
 */
export const APPROVAL_ALWAYS_NOT_AVAILABLE_MESSAGE =
  "Esta cotización no se puede enviar por ahora: tu organización pide aprobación para todas las cotizaciones y la solicitud de aprobación todavía no está disponible. Podrás enviarla cuando llegue; si no puede esperar, pide a quien administra la organización que revise la regla.";

/** El mensaje cuando la base rechaza el envío por la regla y no se pueden dar las cifras (otra persona cambió algo en el medio). */
export const APPROVAL_REQUIRED_GENERIC_MESSAGE = `Esta cotización necesita aprobación según la regla de tu organización. ${APPROVAL_NOT_AVAILABLE_YET}`;

export const APPROVAL_RULE_UNAVAILABLE_MESSAGE =
  "No pudimos revisar si esta cotización necesita aprobación. Intenta de nuevo en unos minutos.";

/** `null` si la cotización puede salir; si no, la frase que explica por qué necesita aprobación. */
export function approvalBlockMessage(rule: ApprovalRule, totals: ApprovalTotals): string | null {
  const metrics = approvalMetrics(totals);
  const reasons = approvalReasons(rule, metrics);
  if (reasons.length === 0) return null;
  if (reasons.includes("always")) return APPROVAL_ALWAYS_NOT_AVAILABLE_MESSAGE;
  return `Esta cotización necesita aprobación: ${describeApprovalReasons(rule, reasons, metrics)}. ${APPROVAL_NOT_AVAILABLE_YET}`;
}

/**
 * El mensaje cuando la base rechaza `prepare_quote_send` por la regla de aprobación. Llega con el mismo código CP423 que «ya no
 * está en borrador», así que se reconoce por el motivo que viaja en el mensaje del error y se revisa ANTES del mensaje general.
 * `null` si el error no es de la regla.
 */
export function approvalPrepareError(reason: string, detail?: string | null): string | null {
  if (reason.startsWith("approval_required")) {
    // `detail` trae los motivos (`always`, `amount`, `discount`): con «Siempre» no se sugiere ajustar la cotización.
    return detail?.split(",").includes("always")
      ? APPROVAL_ALWAYS_NOT_AVAILABLE_MESSAGE
      : APPROVAL_REQUIRED_GENERIC_MESSAGE;
  }
  // La organización sin regla es un daño interno: se rechaza, y se dice con palabras de la persona, sin detalle técnico.
  if (reason.startsWith("approval_rule_missing")) return APPROVAL_RULE_UNAVAILABLE_MESSAGE;
  return null;
}
