import "server-only";
import { createHmac } from "node:crypto";

// Huella buscable (HMAC-SHA256) de datos cifrados. Incluye el campo y la organización, así el
// mismo valor da huellas distintas en cada organización. Ver modelo-datos.md §5.4.

const KEY_VAR = "CP_SEARCH_KEY_V1";
const KEY_BYTES = 32;

function loadKey(): Buffer {
  const raw = process.env[KEY_VAR];
  if (!raw) throw new Error(`Falta la variable de entorno ${KEY_VAR}`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`${KEY_VAR} debe ser de ${KEY_BYTES} bytes en base64`);
  }
  return key;
}

/** `normalizedValue` ya debe venir normalizado (normalizeRut / normalizeEmail). Devuelve hex. */
export function searchHash(field: string, tenantId: string, normalizedValue: string): string {
  return createHmac("sha256", loadKey())
    .update(`${field}|${tenantId}|${normalizedValue}`, "utf8")
    .digest("hex");
}
