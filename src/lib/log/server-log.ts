import "server-only";
import { randomUUID } from "node:crypto";
import { getRequestContext } from "@/lib/http/request-context";

type LogLevel = "info" | "warn" | "error";

/** Solo valores simples: nunca objetos de error completos ni datos personales. */
type LogFields = Record<string, string | number | boolean | null | undefined>;

async function currentRequestId(): Promise<string> {
  try {
    return (await getRequestContext()).requestId;
  } catch {
    // Fuera de una petición (por ejemplo, un script): se genera uno nuevo.
    return randomUUID();
  }
}

/**
 * Log estructurado del servidor (STACK.md §7): una línea JSON con nivel, mensaje y `requestId`.
 * El `requestId` es el mismo que lleva la auditoría de esa petición (`correlation_id`).
 *
 * Regla: nunca pasar datos personales en `fields` (correo, nombre, RUT, teléfono, IP, contraseña).
 * Para seguir un caso usa códigos de error, ids internos o huellas.
 */
export async function serverLog(
  level: LogLevel,
  message: string,
  fields: LogFields = {},
): Promise<void> {
  const line = JSON.stringify({
    level,
    message,
    requestId: await currentRequestId(),
    ...fields,
    time: new Date().toISOString(),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
