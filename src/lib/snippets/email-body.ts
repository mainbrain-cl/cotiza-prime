import { MAX_BODY_LENGTH, parseBasicFormat } from "@/lib/email/basic-format";
import type { SnippetRow } from "./groups";
import { hasVariableInLinkTarget, renderVariables, type SnippetVariableValues } from "./model";

/**
 * El texto del correo al enviar una cotización (H-048b). Las variables (`{{cliente}}`, `{{numero}}`, `{{remitente}}`,
 * `{{organizacion}}`) se completan AL ELEGIR el texto, no al enviar: lo que se guarda y se congela es siempre texto final. Aquí el
 * servidor completa cada texto guardado con los datos de ESTA cotización (los mismos que la pantalla ya muestra) y se los pasa listos
 * al navegador, que solo cambia el contenido del cuadro. Pura: sin base de datos ni navegador.
 */

export type EmailSnippetOption = {
  id: string;
  name: string;
  /** El texto ya con las variables completadas. */
  text: string;
  /** El texto inicial de la organización (a lo más uno). */
  isDefault: boolean;
};

/** Los datos de esta cotización que completan las cuatro variables. */
export function emailVariableValues(input: {
  customerName: string;
  /** Número con versión, como lo ve la persona (`COT-2026-0043 v2`). */
  quoteNumber: string;
  /** Quien envía: solo la autora del borrador puede enviarlo. */
  senderName: string;
  organizationName: string;
}): SnippetVariableValues {
  return {
    cliente: input.customerName,
    numero: input.quoteNumber,
    remitente: input.senderName,
    organizacion: input.organizationName,
  };
}

/**
 * Los textos de correo guardados, completados con los datos de esta cotización. Un texto que ya completado no cabe en el correo o
 * que el formato básico rechazaría no se ofrece (no se puede enviar de todos modos): no debería pasar, porque el texto se prueba al
 * guardarlo, pero un nombre de cliente largo es un dato de hoy y esta cuenta se hace con datos de hoy.
 */
export function emailSnippetOptions(
  rows: readonly Pick<SnippetRow, "id" | "kind" | "name" | "body" | "isDefault">[],
  values: SnippetVariableValues,
): EmailSnippetOption[] {
  return rows.flatMap((row) => {
    if (row.kind !== "email_body") return [];
    // Un texto guardado ANTES de que se prohibiera una variable dentro de la dirección de un enlace no se ofrece: el nombre del cliente
    // decidiría adónde lleva el enlace (revisión de Aarón al PR #67). Hay que editarlo en Configuración.
    if (hasVariableInLinkTarget(row.body)) return [];
    const text = renderVariables(row.body, values);
    if (text.length > MAX_BODY_LENGTH || !parseBasicFormat(text).ok) return [];
    return [{ id: row.id, name: row.name, text, isDefault: row.isDefault }];
  });
}

/** Con qué texto parte el correo: el texto inicial de la organización, y si no hay (o no sirve), el de siempre. */
export function initialEmailBody(options: readonly EmailSnippetOption[], fallback: string): string {
  return options.find((option) => option.isDefault)?.text ?? fallback;
}

/** ¿La persona cambió el texto desde que se puso (el inicial o el último elegido)? Cambiarlo pide confirmar antes de reemplazarlo. */
export const isEmailBodyEdited = (current: string, lastApplied: string): boolean =>
  current !== lastApplied;
