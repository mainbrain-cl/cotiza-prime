import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Cifrado de datos personales en la aplicación (AES-256-GCM). La base nunca tiene la clave.
// Formato: v<N>.<iv base64url>.<cifrado+etiqueta base64url>. Ver modelo-datos.md §5.

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CURRENT_VERSION_VAR = "CP_PII_KEY_CURRENT";

export class PiiCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiiCryptoError";
  }
}

/** Contexto que se sella junto al dato: copiarlo a otra fila o campo hace fallar el descifrado. */
export interface PiiContext {
  table: string;
  field: string;
  tenantId: string;
  rowId: string;
}

function aad(ctx: PiiContext): Buffer {
  return Buffer.from(`${ctx.table}.${ctx.field}|${ctx.tenantId}|${ctx.rowId}`, "utf8");
}

function loadKey(version: string): Buffer {
  const name = `CP_PII_KEY_${version.toUpperCase()}`;
  const raw = process.env[name];
  if (!raw) throw new PiiCryptoError(`Falta la variable de entorno ${name}`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new PiiCryptoError(`${name} debe ser de ${KEY_BYTES} bytes en base64`);
  }
  return key;
}

function currentVersion(): string {
  const version = process.env[CURRENT_VERSION_VAR];
  if (!version || !/^v[0-9]+$/i.test(version)) {
    throw new PiiCryptoError(`${CURRENT_VERSION_VAR} debe tener la forma v1, v2…`);
  }
  return version.toLowerCase();
}

export function encryptPii(plaintext: string, ctx: PiiContext): string {
  const version = currentVersion();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, loadKey(version), iv);
  cipher.setAAD(aad(ctx));
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${version}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

export function decryptPii(token: string, ctx: PiiContext): string {
  const parts = token.split(".");
  if (parts.length !== 3 || !/^v[0-9]+$/.test(parts[0])) {
    throw new PiiCryptoError("Dato cifrado con formato inválido");
  }
  const [version, ivPart, bodyPart] = parts;
  const iv = Buffer.from(ivPart, "base64url");
  const body = Buffer.from(bodyPart, "base64url");
  if (iv.length !== IV_BYTES || body.length < TAG_BYTES) {
    throw new PiiCryptoError("Dato cifrado con formato inválido");
  }
  const key = loadKey(version);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(aad(ctx));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Mensaje fijo: nunca incluye el dato ni el contexto.
    throw new PiiCryptoError("No se pudo descifrar el dato");
  }
}
