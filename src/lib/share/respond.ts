import { z } from "zod";
import { HEADER_UNSAFE } from "@/lib/email/unsafe-characters";

/**
 * Lo que el cliente final puede responder desde su enlace (H-031): reglas y textos compartidos entre
 * la pantalla y el servidor. Sin dependencias del servidor, para poder probarlo solo.
 *
 * Aceptar es un REGISTRO DE CONFORMIDAD (no una firma electrónica avanzada). No se pide RUT
 * (minimización): solo el nombre de quien acepta.
 */

/** Versión del texto de conformidad. Si el texto cambia, cambia la versión: queda guardada con cada aceptación. */
export const ACCEPTANCE_TEXT_VERSION = "v1";
export const ACCEPTANCE_TEXT =
  "Acepto esta cotización en los términos indicados. Entiendo que esto es un registro de conformidad, no una firma electrónica avanzada.";

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 120;
export const REASON_TEXT_MIN_LENGTH = 3;
export const REASON_TEXT_MAX_LENGTH = 200;
/** Tamaño máximo del cuerpo de una respuesta: más que esto no es un formulario de verdad. */
export const RESPOND_BODY_MAX_BYTES = 4_096;

/** Motivos de rechazo, en el orden en que se muestran (código de la base → texto para el cliente). */
export const REJECT_REASONS = [
  { code: "price_too_high", label: "El precio es demasiado alto" },
  { code: "not_in_budget", label: "No está en el presupuesto" },
  { code: "chose_other_provider", label: "Ya acepté la cotización de otra empresa" },
  { code: "timing", label: "El plazo no me sirve" },
  { code: "no_longer_needed", label: "Ya no lo necesito" },
  { code: "other", label: "Otro motivo" },
] as const;

export type RejectReasonCode = (typeof REJECT_REASONS)[number]["code"];
export const REJECT_REASON_CODES = REJECT_REASONS.map((reason) => reason.code) as [
  RejectReasonCode,
  ...RejectReasonCode[],
];

export function reasonLabel(code: string): string {
  return REJECT_REASONS.find((reason) => reason.code === code)?.label ?? "Otro motivo";
}

export const MSG_NAME_REQUIRED = "Escribe tu nombre para aceptar.";
export const MSG_NAME_TOO_LONG = `El nombre puede tener hasta ${NAME_MAX_LENGTH} caracteres.`;
export const MSG_CONFIRM_REQUIRED = "Marca la casilla para confirmar que aceptas.";
export const MSG_REASON_REQUIRED = "Elige el motivo del rechazo.";
export const MSG_REASON_TEXT_REQUIRED = `Cuéntanos brevemente el motivo (entre ${REASON_TEXT_MIN_LENGTH} y ${REASON_TEXT_MAX_LENGTH} caracteres).`;
export const MSG_REASON_TEXT_NOT_ALLOWED = "El detalle solo se usa cuando eliges «Otro motivo».";
export const MSG_INVALID_REQUEST =
  "No pudimos leer tu respuesta. Recarga la página e inténtalo de nuevo.";

const UNSAFE_CHARACTERS = new RegExp(HEADER_UNSAFE.source, "g");

/**
 * Quita caracteres de control, saltos de línea, marcas de dirección y ancho cero, y los espacios
 * sobrantes de un texto de una línea: lo que escribe el cliente va después a un correo interno.
 */
export function cleanOneLine(raw: string): string {
  return raw.replace(UNSAFE_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}

/** Identificador del envío del formulario: el mismo clic repetido lleva el mismo. */
const responseKey = z.uuid({ error: MSG_INVALID_REQUEST });

export const acceptInputSchema = z.object({
  responseKey,
  name: z
    .string({ error: MSG_NAME_REQUIRED })
    .transform(cleanOneLine)
    .pipe(
      z.string().min(NAME_MIN_LENGTH, MSG_NAME_REQUIRED).max(NAME_MAX_LENGTH, MSG_NAME_TOO_LONG),
    ),
  confirmed: z.literal(true, { error: MSG_CONFIRM_REQUIRED }),
});
export type AcceptInput = z.infer<typeof acceptInputSchema>;

export const rejectInputSchema = z
  .object({
    responseKey,
    reasonCode: z.enum(REJECT_REASON_CODES, { error: MSG_REASON_REQUIRED }),
    reasonText: z.string().transform(cleanOneLine).optional(),
  })
  .superRefine((value, ctx) => {
    const text = value.reasonText ?? "";
    if (value.reasonCode === "other") {
      if (text.length < REASON_TEXT_MIN_LENGTH || text.length > REASON_TEXT_MAX_LENGTH) {
        ctx.addIssue({ code: "custom", path: ["reasonText"], message: MSG_REASON_TEXT_REQUIRED });
      }
    } else if (text.length > 0) {
      ctx.addIssue({ code: "custom", path: ["reasonText"], message: MSG_REASON_TEXT_NOT_ALLOWED });
    }
  });
export type RejectInput = z.infer<typeof rejectInputSchema>;

export type FieldErrors = Record<string, string>;

/** Primer mensaje por campo, para mostrarlo junto al campo. */
export function fieldErrorsOf(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in errors)) errors[key] = issue.message;
  }
  return errors;
}

/** Lo que la ruta responde al navegador (nunca datos personales ni detalles técnicos). */
export type RespondOutcome =
  | { status: "ok"; decision: "accepted" | "rejected" }
  | { status: "already_responded"; decision: "accepted" | "rejected" }
  | {
      status: "unavailable";
      reason: "expired" | "revoked" | "superseded" | "not_found" | "not_allowed";
    }
  | { status: "invalid"; fieldErrors: FieldErrors }
  | { status: "error" };
