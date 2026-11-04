import { BASIC_FORMAT_ERROR_MESSAGES, parseBasicFormat } from "@/lib/email/basic-format";
import { renderVariables, type SnippetVariableValues } from "./model";

/**
 * Datos de ejemplo para la vista previa del texto del correo. Son inventados a propósito: la pantalla de
 * ajustes no tiene una cotización real a la vista.
 */
export const SNIPPET_PREVIEW_VALUES: SnippetVariableValues = {
  cliente: "Ana Pérez",
  numero: "COT-2026-0001",
  remitente: "Juan Soto",
  organizacion: "Tu Empresa SpA",
};

export type SnippetEmailFormat = { ok: true; text: string } | { ok: false; message: string };

/**
 * Prueba un texto de correo como lo haría el envío: completa las variables con datos de ejemplo y lo pasa por el
 * lector del formato básico. Sirve para la vista previa y también para NO guardar un texto que después el envío
 * rechazaría (por ejemplo, un enlace que muestra una dirección distinta a la que abre). El mensaje es de lectura
 * simple y nunca repite lo que escribió la persona.
 */
export function checkSnippetEmailFormat(body: string): SnippetEmailFormat {
  const formatted = parseBasicFormat(renderVariables(body, SNIPPET_PREVIEW_VALUES));
  return formatted.ok
    ? { ok: true, text: formatted.text }
    : { ok: false, message: BASIC_FORMAT_ERROR_MESSAGES[formatted.code] };
}
