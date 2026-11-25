import { QUOTE_TEXT_MAX_LENGTH } from "@/lib/quotes/validity";

/**
 * Insertar un texto guardado en un campo de la cotización (H-048b). Pura: no toca el navegador ni la base.
 * Reglas del diseño: el texto se agrega AL FINAL, separado por una línea en blanco; si ya está, no se agrega dos veces; y si el
 * resultado pasaría del máximo del campo, no se agrega y se dice cuánto quedaría.
 */

export type InsertResult =
  | { status: "ok"; text: string }
  | { status: "already_added" }
  | { status: "too_long"; resultingLength: number; max: number };

/** El largo con que se cuenta un campo de la cotización: sin los espacios de los bordes (igual que el editor y la base). */
export const fieldLength = (text: string): number => text.trim().length;

/** Las líneas de un texto, sin espacios a los lados y sin las vacías (los saltos de Windows `\r\n` cuentan como uno). */
const linesOf = (text: string): string[] =>
  text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * ¿Este texto guardado ya está dentro del campo? Se compara por LÍNEAS completas, no por pedazos de texto: «No incluye IVA» no está en
 * un campo que dice «No incluye IVA ni transporte.» (es otra frase), pero sí lo está si el campo lo trae como una línea propia, sola, en
 * un párrafo con otras líneas (como se escriben las exclusiones, una debajo de otra) o junto a otros párrafos. Un texto de varias
 * líneas tiene que estar completo, en orden y seguido (revisión de Aarón al PR #67 y de Opus).
 */
export function isSnippetInField(field: string, body: string): boolean {
  const wanted = linesOf(body);
  if (wanted.length === 0) return false;
  const have = linesOf(field);
  for (let start = 0; start + wanted.length <= have.length; start += 1) {
    if (wanted.every((line, offset) => have[start + offset] === line)) return true;
  }
  return false;
}

export function appendSnippet(
  field: string,
  body: string,
  max: number = QUOTE_TEXT_MAX_LENGTH,
): InsertResult {
  if (isSnippetInField(field, body)) return { status: "already_added" };
  const addition = body.trim();
  const current = field.trimEnd();
  const text = current === "" ? addition : `${current}\n\n${addition}`;
  const resultingLength = fieldLength(text);
  if (resultingLength > max) return { status: "too_long", resultingLength, max };
  return { status: "ok", text };
}

/** El texto de «no cabe», con los números a la chilena (`4.312`). */
export function tooLongMessage(resultingLength: number, max: number): string {
  return `No cabe: quedaría con ${resultingLength.toLocaleString("es-CL")} caracteres (máximo ${max.toLocaleString("es-CL")})`;
}
