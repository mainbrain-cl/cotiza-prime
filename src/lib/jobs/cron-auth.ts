import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { serverLog } from "@/lib/log/server-log";
import { publicJson, publicText } from "@/lib/share/public-request";

/**
 * Secreto con que el programador de tareas del hosting (Vercel Cron) se identifica ante las rutas de
 * `/api/v1/jobs/*` (decisión #17). Vercel envía `Authorization: Bearer <CRON_SECRET>` cuando la variable
 * existe en el proyecto. Es solo de servidor y distinto en cada entorno.
 *
 * ÚNICO lugar donde se lee `CRON_SECRET` y se verifica a quien llama. Toda ruta de `/api/v1/jobs/*` exporta
 * solo `GET = cronJobRoute(...)`, que resuelve TODO aquí adentro (la guardia 8f de `tests/isolation` lo exige):
 * así una ruta nueva no puede olvidarse de verificar el secreto, ni tratar mal su resultado.
 */
export const CRON_SECRET_VAR = "CRON_SECRET";
export const MIN_CRON_SECRET_LENGTH = 32;

/**
 * - `disabled`: no hay secreto o es corto. La ruta queda desactivada (404): nunca se acepta un secreto
 *   vacío ni «undefined».
 * - `unauthorized`: falta el encabezado, no es `Bearer` o el valor no coincide (401).
 * - `ok`: el secreto coincide.
 */
export type CronAuthResult = "disabled" | "unauthorized" | "ok";

const BEARER_PREFIX = /^Bearer\s+/i;

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Compara el encabezado `Authorization` con `CRON_SECRET` (leído de la variable de entorno; se le quitan los
 * espacios y saltos de línea de los bordes, que se cuelan al pegar el valor) en tiempo constante: se comparan
 * las huellas sha256 de ambos (siempre del mismo largo), así ni el contenido ni el largo del secreto se filtran
 * por el tiempo de respuesta. Nunca registra ni devuelve ninguno de los dos valores.
 */
export function verifyCronRequest(authorization: string | null): CronAuthResult {
  const configuredSecret = process.env[CRON_SECRET_VAR]?.trim();
  if (!configuredSecret || configuredSecret.length < MIN_CRON_SECRET_LENGTH) return "disabled";
  if (!authorization || !BEARER_PREFIX.test(authorization)) return "unauthorized";
  const received = authorization.replace(BEARER_PREFIX, "");
  if (received.length === 0) return "unauthorized";
  return timingSafeEqual(sha256(received), sha256(configuredSecret)) ? "ok" : "unauthorized";
}

/** Lo que devuelve una tarea: `failed` dice que no pudo ni empezar; el resto son solo conteos. */
export type CronJobResult = { failed: boolean } & Record<string, number | boolean>;

/**
 * El manejador `GET` completo de una tarea programada. Orden: (1) el secreto, en tiempo constante y sin tocar
 * la base ni la red; (2) recién entonces corre la tarea.
 *
 * - Sin `CRON_SECRET` válido: 404 (desactivada). En producción además queda un error en el log
 *   (`cron_job_disabled`, sin el valor) porque significa que el programador llama a una ruta apagada.
 * - Secreto ausente o incorrecto: 401 con un cuerpo genérico.
 * - La tarea no pudo ni empezar (`failed`): 500 genérico, para que el programador la marque como error.
 * - Si no: 200 con `{ job, ...conteos }`. Nunca correos, nombres ni el secreto, ni en la respuesta ni en los logs.
 *
 * Todas las respuestas llevan `Cache-Control: private, no-store`.
 */
export function cronJobRoute(
  jobName: string,
  run: () => Promise<CronJobResult>,
): (request: Request) => Promise<Response> {
  return async function handle(request: Request): Promise<Response> {
    const auth = verifyCronRequest(request.headers.get("authorization"));
    if (auth === "disabled") {
      if (process.env.NODE_ENV === "production") {
        await serverLog("error", "cron_job_disabled", { job: jobName });
      }
      return publicText("No encontrado.", 404);
    }
    if (auth === "unauthorized") {
      await serverLog("warn", "cron_job_unauthorized", { job: jobName });
      return publicText("No autorizado.", 401);
    }
    const result = await run();
    if (result.failed) {
      await serverLog("error", "cron_job_failed", { job: jobName });
      return publicJson({ job: jobName, failed: true }, 500);
    }
    await serverLog("info", "cron_job_done", { job: jobName, ...result });
    return publicJson({ job: jobName, ...result });
  };
}
