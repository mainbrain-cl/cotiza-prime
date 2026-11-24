import { z } from "zod";
import { MAX_BODY_LENGTH } from "@/lib/email/basic-format";
import { MAX_SENDER_NAME_LENGTH, MAX_SUBJECT_LENGTH } from "@/lib/email/quote-email";
import { HEADER_UNSAFE } from "@/lib/email/unsafe-characters";
import { NAME_MAX_LENGTH } from "@/lib/auth/schemas";
import { CUSTOMER_NAME_MAX_LENGTH } from "@/lib/customers/schemas";
import { hasUnresolvedVariables, sanitizeVariableValue } from "@/lib/snippets/model";
import { TENANT_NAME_MAX_LENGTH } from "@/lib/tenant/schemas";

/**
 * Textos y validación del envío de una cotización (H-029). Sin dependencias del servidor: los usa la
 * pantalla de redactar (texto de partida y vista previa) y la acción que envía.
 */

const SALUTATION_FALLBACK = "cliente";
const CONTROL_CHARACTERS = new RegExp(HEADER_UNSAFE.source, "g");

const cleanInline = (value: string): string =>
  value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();

/** Asunto de partida: `Cotización COT-2026-0043 de Nombre de la organización`. */
export function defaultEmailSubject(numberDisplay: string, organizationName: string): string {
  const organization = [...cleanInline(organizationName)].slice(0, MAX_SENDER_NAME_LENGTH).join("");
  return `Cotización ${cleanInline(numberDisplay)} de ${organization}`.slice(0, MAX_SUBJECT_LENGTH);
}

export const DEFAULT_EMAIL_BODY_INTRO =
  "Le hacemos llegar la cotización correspondiente a su solicitud. Puede revisarla y aceptarla desde el botón de este correo; también la adjuntamos en PDF.";
export const DEFAULT_EMAIL_BODY_CLOSING = "Quedamos atentos a cualquier consulta.";
export const DEFAULT_EMAIL_BODY_FAREWELL = "Saludos cordiales,";

/** Texto de partida del correo, en el formato básico. Quien envía lo ajusta antes de mandarlo. */
export function defaultEmailBody(input: {
  customerName: string;
  authorName: string;
  organizationName: string;
}): string {
  // Los nombres pasan por el mismo saneo que las variables de un texto guardado: un cliente u organización con «{{cliente}}» en el nombre
  // no puede dejar una variable sin completar (apagaría «Enviar»), ni un nombre con `[texto](https://…)` o `**` volverse enlace o negrita
  // (revisión de Aarón al PR #67). El asunto no pasa por aquí: no lee variables ni formato.
  // Sin el tope de 100 caracteres de las variables: cada nombre llega hasta el máximo que admite la aplicación (cliente, organización y
  // persona), así no se corta a mitad de palabra y sin los espacios que el saneo agrega a los bordes para cuando dos valores quedan pegados
  // (aquí van entre un texto fijo y un salto de línea).
  const safe = (value: string, max: number): string =>
    sanitizeVariableValue(cleanInline(value), max).trim();
  const customer = safe(input.customerName, CUSTOMER_NAME_MAX_LENGTH) || SALUTATION_FALLBACK;
  const signature = [
    safe(input.authorName, NAME_MAX_LENGTH),
    safe(input.organizationName, TENANT_NAME_MAX_LENGTH),
  ].filter((line) => line !== "" && line !== "—");
  return [
    `Estimado/a ${customer}:`,
    DEFAULT_EMAIL_BODY_INTRO,
    DEFAULT_EMAIL_BODY_CLOSING,
    [DEFAULT_EMAIL_BODY_FAREWELL, ...signature].join("\n"),
  ].join("\n\n");
}

export const SEND_SUBJECT_REQUIRED = "Escribe el asunto del correo.";
export const SEND_SUBJECT_TOO_LONG = `El asunto no puede pasar de ${MAX_SUBJECT_LENGTH} caracteres.`;
export const SEND_SUBJECT_INVALID = "El asunto tiene caracteres que no se pueden enviar.";
export const SEND_BODY_REQUIRED = "Escribe el texto del correo.";
export const SEND_BODY_HAS_VARIABLES =
  "El texto del correo todavía tiene una variable sin completar ({{ }}). Escribe el dato o elige el texto de nuevo.";

export const sendQuoteInputSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(1, SEND_SUBJECT_REQUIRED)
    .max(MAX_SUBJECT_LENGTH, SEND_SUBJECT_TOO_LONG)
    .refine((value) => !HEADER_UNSAFE.test(value), SEND_SUBJECT_INVALID),
  body: z
    .string()
    .min(1, SEND_BODY_REQUIRED)
    .max(MAX_BODY_LENGTH)
    // Un correo con `{{cliente}}` escrito nunca sale (H-048b): las variables se completan al elegir el texto.
    .refine((value) => !hasUnresolvedVariables(value), SEND_BODY_HAS_VARIABLES),
  expectedRevision: z.number().int().min(1),
  /** Clave de este envío: un doble clic repite la misma y no duplica el correo. */
  sendKey: z.uuid(),
});

export type SendQuoteInput = z.infer<typeof sendQuoteInputSchema>;

export const resendQuoteInputSchema = z.object({ resendKey: z.uuid() });
