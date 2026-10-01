/**
 * Formato y reglas de la numeración de cotizaciones (H-024, decisión 008).
 *
 * Reproduce en TypeScript lo que hace la base de datos (`app.format_quote_number` y `set_numbering`),
 * solo para mostrar la vista previa. El número real lo asigna siempre la base de datos.
 */

export const NUMBERING_MODES = ["yearly", "continuous"] as const;
export type NumberingMode = (typeof NUMBERING_MODES)[number];

export const BUSINESS_TIMEZONE = "America/Santiago";
export const DEFAULT_PAD_WIDTH = 4;

/** Año calendario en la zona horaria del negocio (igual que `app.current_business_year()`). */
export function businessYear(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
  }).formatToParts(now);
  return Number(parts.find((part) => part.type === "year")?.value);
}

/** Alcance del contador: `continuous` o `Y2026`. */
export function numberingScope(mode: NumberingMode, year: number): string {
  return mode === "continuous" ? "continuous" : `Y${year}`;
}

/** Texto visible. Rellena con ceros solo cuando hace falta: un número largo nunca se corta. */
export function formatQuoteNumber(input: {
  prefix: string;
  mode: NumberingMode;
  padWidth: number;
  year: number;
  sequence: number;
}): string {
  const { prefix, mode, padWidth, year, sequence } = input;
  const digits = String(sequence).padStart(padWidth, "0");
  return mode === "yearly" ? `${prefix}-${year}-${digits}` : `${prefix}-${digits}`;
}

/**
 * El menor número que se puede pedir como próximo: nunca menor que el último usado en el formato
 * actual ni en el nuevo (modelo-datos.md §6.3).
 */
export function minimumNextNumber(lastInCurrentScope: number, lastInNewScope: number): number {
  return Math.max(lastInCurrentScope, lastInNewScope) + 1;
}

export function tooLowMessage(minimum: number): string {
  return `El próximo número no puede ser menor que ${minimum}.`;
}
