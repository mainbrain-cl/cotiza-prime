import { createHash, randomBytes } from "node:crypto";
import { normalizeEmail } from "@/lib/normalize/email";

/**
 * El código secreto del enlace de una invitación (H-008). 32 bytes al azar escritos en base64url: 43
 * caracteres imposibles de adivinar. El código viaja SOLO en el correo: en la base de datos se guarda su
 * huella (`token_sha256`) y nunca el código; tampoco va a logs ni a la auditoría. Cada envío, también un
 * reenvío, lleva un código nuevo y el anterior deja de servir.
 */
export const INVITATION_TOKEN_BYTES = 32;
export const INVITATION_TOKEN_LENGTH = 43;
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Dirección (dentro de la aplicación) que abre el enlace del correo. La ruta la construye H-009. */
export const INVITATION_PATH_PREFIX = "/invitacion";

export function newInvitationToken(): string {
  return randomBytes(INVITATION_TOKEN_BYTES).toString("base64url");
}

/** ¿Tiene la forma de un código? Se comprueba ANTES de consultar la base de datos. */
export function isWellFormedInvitationToken(value: string): boolean {
  return INVITATION_TOKEN_PATTERN.test(value);
}

/** Huella del código (64 caracteres hexadecimales): lo único que se guarda y se compara. */
export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * El vínculo de una invitación con su correo: sha256 de «huella del código | correo normalizado». Con él la
 * base de datos, sola, comprueba que quien acepta usa el mismo correo al que se envió (H-009) y que alguien
 * ya es miembro (H-008). Es el gemelo de `app.invitation_binding` en SQL; hay una prueba de paridad.
 */
export function invitationEmailBinding(tokenSha256: string, email: string): string {
  return createHash("sha256").update(`${tokenSha256}|${normalizeEmail(email)}`, "utf8").digest("hex");
}

/** La dirección completa que va en el correo: `{origen}/invitacion/{código}`. */
export function invitationUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}${INVITATION_PATH_PREFIX}/${token}`;
}
