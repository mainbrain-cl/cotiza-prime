import { z } from "zod";
import { MAX_BODY_LENGTH } from "@/lib/email/basic-format";
import { MAX_SENDER_NAME_LENGTH, MAX_SUBJECT_LENGTH } from "@/lib/email/quote-email";
import { HEADER_UNSAFE } from "@/lib/email/unsafe-characters";

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
  const customer = cleanInline(input.customerName) || SALUTATION_FALLBACK;
  const signature = [cleanInline(input.authorName), cleanInline(input.organizationName)].filter(
    (line) => line !== "" && line !== "—",
  );
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

export const sendQuoteInputSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(1, SEND_SUBJECT_REQUIRED)
    .max(MAX_SUBJECT_LENGTH, SEND_SUBJECT_TOO_LONG)
    .refine((value) => !HEADER_UNSAFE.test(value), SEND_SUBJECT_INVALID),
  body: z.string().min(1, SEND_BODY_REQUIRED).max(MAX_BODY_LENGTH),
  expectedRevision: z.number().int().min(1),
  /** Clave de este envío: un doble clic repite la misma y no duplica el correo. */
  sendKey: z.uuid(),
});

export type SendQuoteInput = z.infer<typeof sendQuoteInputSchema>;

export const resendQuoteInputSchema = z.object({ resendKey: z.uuid() });
