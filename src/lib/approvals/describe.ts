/**
 * La frase que dice cómo quedó la regla de aprobación (H-040, diseño §4) y, para el sprint 6, el motivo por el que una
 * cotización la necesita. Pura: la pantalla la recalcula al escribir y el registro de actividad la usa para contar el cambio.
 */
import { formatClp } from "@/lib/money/clp";
import { formatPercentBp } from "@/lib/quotes/format";
import type { ApprovalMetrics, ApprovalReason, ApprovalRule } from "./rule";

/** Texto de ayuda fijo, debajo de las opciones. */
export const APPROVAL_RULE_HELP =
  "El total incluye IVA. El descuento suma los descuentos de cada línea y el descuento general, sobre el valor antes de descuentos.";

/** Aviso fijo del formulario. */
export const APPROVAL_RULE_SCOPE_NOTE =
  "El cambio aplica a las cotizaciones que se envíen desde ahora; las ya enviadas no cambian.";

const AMOUNT_PIECE = (clp: number) => `el total supera ${formatClp(clp)}`;
const DISCOUNT_PIECE = (bp: number) =>
  bp === 0
    ? "la cotización tiene cualquier descuento"
    : `el descuento supera ${formatPercentBp(bp)}%`;

/**
 * «No se pide aprobación: las cotizaciones se envían directo.» · «Se pide aprobación para todas las cotizaciones.» ·
 * «Se pide aprobación si el total supera $2.000.000.» · «…si el descuento supera 10%.» · «…si el total supera $2.000.000 o
 * el descuento supera 10%.» · con umbral 0: «…si la cotización tiene cualquier descuento.»
 */
export function describeApprovalRule(rule: ApprovalRule): string {
  if (rule.mode === "never") return "No se pide aprobación: las cotizaciones se envían directo.";
  if (rule.mode === "always") return "Se pide aprobación para todas las cotizaciones.";
  const pieces: string[] = [];
  if (rule.amountThresholdClp !== null) pieces.push(AMOUNT_PIECE(rule.amountThresholdClp));
  if (rule.discountThresholdBp !== null) pieces.push(DISCOUNT_PIECE(rule.discountThresholdBp));
  // Una regla condicional sin condiciones no existe (la base lo impide); si llegara, se dice la verdad.
  if (pieces.length === 0) return "No se pide aprobación: las cotizaciones se envían directo.";
  return `Se pide aprobación si ${pieces.join(" o ")}.`;
}

/**
 * Por qué ESTA cotización necesita aprobación, con sus cifras: «el total ($2.350.000) supera $2.000.000». Para el bloqueo de
 * `/enviar` (H-040b) y, en el sprint 6, el motivo que ve quien aprueba. Vacío si `reasons` está vacío.
 */
export function describeApprovalReasons(
  rule: ApprovalRule,
  reasons: readonly ApprovalReason[],
  metrics: ApprovalMetrics,
): string {
  const pieces: string[] = [];
  for (const reason of reasons) {
    if (reason === "always")
      pieces.push("la organización pide aprobación para todas las cotizaciones");
    if (reason === "amount" && rule.amountThresholdClp !== null) {
      pieces.push(
        `el total (${formatClp(metrics.totalClp)}) supera ${formatClp(rule.amountThresholdClp)}`,
      );
    }
    if (reason === "discount" && rule.discountThresholdBp !== null) {
      pieces.push(
        rule.discountThresholdBp === 0
          ? `la cotización tiene un descuento (${formatClp(metrics.discountClp)})`
          : `el descuento (${formatPercentBp(metrics.discountBp)}%) supera ${formatPercentBp(rule.discountThresholdBp)}%`,
      );
    }
  }
  return pieces.join(" y ");
}
