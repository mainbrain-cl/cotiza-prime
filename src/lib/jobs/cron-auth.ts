import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Secreto con que el programador de tareas del hosting (Vercel Cron) se identifica ante las rutas de
 * `/api/v1/jobs/*` (decisión #17). Vercel envía `Authorization: Bearer <CRON_SECRET>` cuando la variable
 * existe en el proyecto. Es solo de servidor y distinto en cada entorno.
 *
 * ÚNICO lugar donde se lee `CRON_SECRET` y se verifica a quien llama: toda ruta de `/api/v1/jobs/*` llama
 * `verifyCronRequest` antes de hacer cualquier otra cosa (una guardia de `tests/isolation` lo exige).
 */
export const CRON_SECRET_VAR = "CRON_SECRET";
export const MIN_CRON_SECRET_LENGTH = 32;

/**
 * - `disabled`: no hay secreto o es corto. La ruta no existe para nadie (404): nunca se acepta un secreto
 *   vacío ni «undefined».
 * - `unauthorized`: falta el encabezado, no es `Bearer` o el valor no coincide (401).
 * - `ok`: el secreto coincide.
 */
export type CronAuthResult = "disabled" | "unauthorized" | "ok";

const BEARER_PREFIX = /^Bearer\s+/i;

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Compara el encabezado `Authorization` con `CRON_SECRET` en tiempo constante: se comparan las huellas
 * sha256 de ambos (siempre del mismo largo), así ni el contenido ni el largo del secreto se filtran por el
 * tiempo de respuesta. Nunca registra ni devuelve ninguno de los dos valores.
 *
 * `configuredSecret` solo se pasa en pruebas; por defecto se lee la variable de entorno.
 */
export function verifyCronRequest(
  authorization: string | null,
  configuredSecret: string | undefined = process.env[CRON_SECRET_VAR],
): CronAuthResult {
  if (!configuredSecret || configuredSecret.length < MIN_CRON_SECRET_LENGTH) return "disabled";
  if (!authorization || !BEARER_PREFIX.test(authorization)) return "unauthorized";
  const received = authorization.replace(BEARER_PREFIX, "");
  if (received.length === 0) return "unauthorized";
  return timingSafeEqual(sha256(received), sha256(configuredSecret)) ? "ok" : "unauthorized";
}
