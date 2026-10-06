import { createHash, randomBytes } from "node:crypto";

/**
 * Token del enlace del cliente (decisión 017): 32 bytes al azar escritos en base64url, es decir, 43
 * caracteres imposibles de adivinar. En la base de datos solo se guarda su sello (sha256 en hex): quien
 * lea la base no puede reconstruir un enlace. Cada correo, también un reenvío, lleva un token nuevo.
 */
export const SHARE_TOKEN_BYTES = 32;
export const SHARE_TOKEN_LENGTH = 43;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

/** ¿Tiene la forma de un token? Se comprueba ANTES de consultar la base de datos. */
export function isWellFormedShareToken(value: string): boolean {
  return SHARE_TOKEN_PATTERN.test(value);
}

/** Sello del token (64 caracteres hexadecimales): lo único que se guarda y se compara. */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
