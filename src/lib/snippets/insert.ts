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

/** ¿Este texto guardado ya está dentro del campo? Se compara sin los espacios de los bordes. */
export function isSnippetInField(field: string, body: string): boolean {
  const wanted = body.trim();
  return wanted !== "" && field.includes(wanted);
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
