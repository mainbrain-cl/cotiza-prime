/**
 * Cómo se muestran las cotizaciones: número, cantidades con coma, porcentajes y estados.
 * Montos en pesos: `formatClp` (src/lib/money/clp.ts).
 */

import type { QuoteStatus } from "@/components/ui/status-badge";

const MILLI_PER_UNIT = 1000;
const MILLI_DIGITS = 3;
const BP_PER_PERCENT = 100;

/** `COT-2026-0043` y versión 2 -> `COT-2026-0043 v2`. La versión 1 no lleva sufijo. */
export function formatQuoteNumber(display: string, version: number): string {
  return version > 1 ? `${display} v${version}` : display;
}

const groupThousands = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** Cantidad en milésimas -> texto con coma: `2500` -> `2,5`; `1000` -> `1`; `1` -> `0,001`. */
export function formatQuantity(milli: number): string {
  if (!Number.isSafeInteger(milli) || milli < 0) throw new RangeError("Cantidad inválida.");
  const integer = Math.floor(milli / MILLI_PER_UNIT);
  const fraction = String(milli % MILLI_PER_UNIT)
    .padStart(MILLI_DIGITS, "0")
    .replace(/0+$/, "");
  return fraction === ""
    ? groupThousands(String(integer))
    : `${groupThousands(String(integer))},${fraction}`;
}

/** Puntos base -> porcentaje con coma, sin el signo: `1250` -> `12,5`; `1000` -> `10`. */
export function formatPercentBp(bp: number): string {
  if (!Number.isSafeInteger(bp) || bp < 0) throw new RangeError("Porcentaje inválido.");
  const integer = Math.floor(bp / BP_PER_PERCENT);
  const fraction = String(bp % BP_PER_PERCENT)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return fraction === "" ? String(integer) : `${integer},${fraction}`;
}

/** Tasa de IVA para la etiqueta de los totales: `1900` -> `19%`; `1950` -> `19,5%`. */
export function formatTaxRate(bp: number): string {
  return `${formatPercentBp(bp)}%`;
}

/** Estados de la base de datos -> estados de la insignia (los nombres de dos de ellos difieren). */
const BADGE_STATUS: Record<string, QuoteStatus> = {
  rejected_by_customer: "rejected_by_client",
  superseded: "replaced",
};

export function toBadgeStatus(dbStatus: string): QuoteStatus {
  return (BADGE_STATUS[dbStatus] ?? dbStatus) as QuoteStatus;
}

/** Estados en los que el borrador todavía se puede editar (decisión: solo su autor). */
export const EDITABLE_STATUSES: readonly string[] = ["draft", "changes_requested"];
