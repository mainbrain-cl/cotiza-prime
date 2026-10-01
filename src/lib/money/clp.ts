/**
 * Pesos chilenos (CLP): siempre números enteros, sin decimales (PROYECTO.md §0 y §13.7).
 * Formato visible: `$1.250.000` (punto como separador de miles).
 *
 * Único lugar donde se formatea y se lee dinero escrito por una persona.
 */

/** Tope razonable para un precio o monto: un billón de pesos cabe de sobra en un entero seguro. */
export const MAX_CLP = 1_000_000_000_000;

export type ParseClpResult =
  | { ok: true; value: number }
  | { ok: false; reason: "empty" | "negative" | "decimal" | "invalid" | "too_large" };

const THOUSANDS_GROUPED = /^\d{1,3}(\.\d{3})+$/;
const DIGITS_ONLY = /^\d+$/;
const LOOKS_DECIMAL = /^\d+\.\d{1,2}$/;

/** `1250000` -> `$1.250.000`. Solo acepta enteros seguros. */
export function formatClp(amount: number): string {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError("Los pesos deben ser un número entero.");
  }
  const sign = amount < 0 ? "-" : "";
  const grouped = String(Math.abs(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}$${grouped}`;
}

/**
 * Lee lo que escribió una persona: `1250000`, `1.250.000`, `$ 1.250.000`.
 * Rechaza decimales (`1250,5`, `1.25`), negativos y cualquier cosa que no sea un monto.
 */
export function parseClp(input: string): ParseClpResult {
  const text = input.replace(/[\s$]/g, "");
  if (text === "") return { ok: false, reason: "empty" };
  if (text.startsWith("-")) return { ok: false, reason: "negative" };
  if (text.includes(",")) return { ok: false, reason: "decimal" };
  if (text.includes(".") && !THOUSANDS_GROUPED.test(text)) {
    // "1.25" o "1250.5" parecen decimales; "1.2.3" es solo ilegible.
    return { ok: false, reason: LOOKS_DECIMAL.test(text) ? "decimal" : "invalid" };
  }
  const digits = text.replaceAll(".", "");
  if (!DIGITS_ONLY.test(digits)) return { ok: false, reason: "invalid" };
  const value = Number(digits);
  if (value > MAX_CLP) return { ok: false, reason: "too_large" };
  return { ok: true, value };
}
