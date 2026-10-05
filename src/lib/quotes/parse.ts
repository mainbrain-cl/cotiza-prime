/**
 * Lectura de lo que escribe una persona: cantidades y porcentajes con coma decimal.
 * El punto solo se acepta como separador de miles, en grupos de 3 (`1.000,25`).
 * Todo resultado es un entero: cantidad en milésimas, porcentaje en puntos base (1 pb = 0,01%).
 */

import { PERCENT_MAX_BP, QUANTITY_MAX_MILLI, QUANTITY_MIN_MILLI } from "./calc";

export type ParseResult = { ok: true; value: number } | { ok: false; message: string };

const THOUSANDS_GROUPED = /^\d{1,3}(\.\d{3})+$/;
const DIGITS_ONLY = /^\d+$/;
const DOT_DECIMAL = /^\d+\.\d+$/;

const QUANTITY_DECIMALS = 3;
const PERCENT_DECIMALS = 2;

type Split = { ok: true; integer: string; fraction: string } | { ok: false; message: string };

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

function splitNumber(
  raw: string,
  maxDecimals: number,
  noun: string,
  allowPercentSign: boolean,
): Split {
  const unreadable = `No se entiende ${noun}. Usa solo números y coma para decimales: 2,5`;
  const text = raw.replace(allowPercentSign ? /[\s%]/g : /\s/g, "");
  if (text === "") return fail(`Escribe ${noun}.`);
  if (text.startsWith("-")) return fail("No puede ser negativo.");
  const parts = text.split(",");
  if (parts.length > 2) return fail("Usa una sola coma para los decimales: 2,5");
  const fraction = parts[1] ?? "";
  let integer = parts[0];
  if (integer.includes(".")) {
    if (THOUSANDS_GROUPED.test(integer)) {
      integer = integer.replaceAll(".", "");
    } else if (parts.length === 1 && DOT_DECIMAL.test(text)) {
      return fail("Usa coma para decimales: 2,5");
    } else {
      return fail(unreadable);
    }
  }
  if (!DIGITS_ONLY.test(integer)) return fail(unreadable);
  if (parts.length === 2 && !DIGITS_ONLY.test(fraction)) return fail(unreadable);
  if (fraction.length > maxDecimals) return fail(`Máximo ${maxDecimals} decimales.`);
  return { ok: true, integer, fraction };
}

/** `"2,5"` -> `2500` (milésimas). Entre 0,001 y 1.000.000. */
export function parseQuantity(input: string): ParseResult {
  const split = splitNumber(input, QUANTITY_DECIMALS, "una cantidad", false);
  if (!split.ok) return split;
  const milli = Number(split.integer + split.fraction.padEnd(QUANTITY_DECIMALS, "0"));
  if (milli < QUANTITY_MIN_MILLI) return fail("La cantidad debe ser mayor que 0.");
  if (milli > QUANTITY_MAX_MILLI)
    return fail("La cantidad es demasiado grande (máximo 1.000.000).");
  return { ok: true, value: milli };
}

/** `"12,5"` -> `1250` (puntos base). Entre 0% y 100%. */
export function parsePercent(input: string): ParseResult {
  const split = splitNumber(input, PERCENT_DECIMALS, "un porcentaje", true);
  if (!split.ok) return split;
  const bp = Number(split.integer + split.fraction.padEnd(PERCENT_DECIMALS, "0"));
  if (bp > PERCENT_MAX_BP) return fail("El porcentaje no puede pasar de 100%.");
  return { ok: true, value: bp };
}
