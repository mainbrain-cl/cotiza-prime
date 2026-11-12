import { createHash, randomBytes } from "node:crypto";

/**
 * El código secreto del enlace para anular la activación del segundo paso (H-118). 32 bytes al azar en base64url (43
 * caracteres, 256 bits): imposible de adivinar. Viaja SOLO en el correo, en la parte «#» de la dirección: el navegador no
 * manda esa parte al servidor, así que no queda en registros de acceso ni lo ve un escáner de enlaces. En la base se guarda
 * su huella sha256 y nunca el código; tampoco va a un log ni a la auditoría.
 */
export const MFA_ANNUL_TOKEN_BYTES = 32;
export const MFA_ANNUL_TOKEN_LENGTH = 43;
const MFA_ANNUL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Dirección (dentro de la aplicación) de la página que usa el enlace. La página es de H-118b. */
export const MFA_ANNUL_PATH = "/cuenta/anular-dos-pasos";

export function newMfaAnnulToken(): string {
  return randomBytes(MFA_ANNUL_TOKEN_BYTES).toString("base64url");
}

/** ¿Tiene la forma de un código? Se comprueba ANTES de consultar la base de datos. */
export function isWellFormedMfaAnnulToken(value: string): boolean {
  return MFA_ANNUL_TOKEN_PATTERN.test(value);
}

/** Huella del código (64 hexadecimales): lo único que se guarda y se compara. */
export function hashMfaAnnulToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** La dirección completa del botón del correo: `{origen}/cuenta/anular-dos-pasos#{código}`. El código va tras el «#». */
export function mfaAnnulUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}${MFA_ANNUL_PATH}#${token}`;
}
