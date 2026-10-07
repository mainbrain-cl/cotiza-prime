import { createHash } from "node:crypto";

/**
 * Identificador del cliente NUEVO que nace al convertir una solicitud (H-090). Sale siempre de la
 * organización y la solicitud, nunca al azar: así un doble clic, un reintento tras un fallo y dos
 * pestañas abiertas a la vez llegan al MISMO cliente (la base rechaza el segundo `insert` y se
 * reutiliza el primero) y una solicitud nunca deja dos clientes. Es un UUID con la forma de la
 * versión 4 (los de la base), pero determinista. No es un secreto ni un dato personal.
 */
export function deriveConvertCustomerId(tenantId: string, requestId: string): string {
  const hex = createHash("sha256")
    .update(`intake-convert-customer|${tenantId.toLowerCase()}|${requestId.toLowerCase()}`)
    .digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
