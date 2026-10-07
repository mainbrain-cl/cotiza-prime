import type { PublicFormContent } from "./public-view";

/**
 * Lo que responde `POST /api/v1/public/forms/[publicId]/requests` y que entiende la pantalla. Todo son
 * textos ya escritos en el servidor, en español de Chile: nunca se repite lo que escribió el visitante ni
 * se explica por qué falló una protección.
 */

export const MSG_RECEIVED_DEFAULT = "Recibimos tu solicitud. La organización te responderá pronto.";
export const MSG_BLOCKED = "No pudimos verificar el envío. Recarga la página e inténtalo de nuevo.";
export const MSG_ANTIBOT = "No pudimos confirmar que eres una persona. Inténtalo de nuevo.";
export const MSG_EXPIRED =
  "Este formulario estuvo abierto demasiado tiempo. Recarga la página para enviarlo.";
export const MSG_UNREADABLE =
  "No pudimos leer el formulario. Recarga la página e inténtalo de nuevo.";
export const MSG_TOO_LARGE = "Lo que escribiste es demasiado largo. Acórtalo e inténtalo de nuevo.";
export const MSG_FORM_CHANGED =
  "La organización actualizó el formulario. Revisa tus datos y vuelve a enviarlo.";
export const MSG_PAUSED = "Este formulario no está recibiendo solicitudes por ahora.";
export const MSG_CAP_REACHED =
  "Este formulario no recibe más solicitudes hoy. Inténtalo mañana o escríbele directo a la organización.";
export const MSG_CONFLICT =
  "Ya recibimos un envío parecido. Recarga la página e inténtalo de nuevo.";
export const MSG_NOT_FOUND = "Este formulario no existe o ya no está disponible.";
export const MSG_ERROR = "Tuvimos un problema de nuestro lado. Inténtalo de nuevo en un momento.";
export const MSG_RATE_LIMITED =
  "Enviaste demasiadas solicitudes en poco tiempo. Espera unos minutos e inténtalo de nuevo.";

export type SubmitResponse =
  | { status: "ok"; message: string }
  | { status: "invalid"; fieldErrors: Record<string, string> }
  | { status: "form_changed"; message: string; content: PublicFormContent; renderToken: string }
  | { status: "paused" | "cap_reached" | "conflict" | "not_found"; message: string }
  | { status: "blocked" | "rate_limited" | "error"; message: string };
