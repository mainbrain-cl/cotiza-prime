import {
  SEND_TIMEOUT_MS,
  type EmailMessage,
  type EmailSendResult,
  type EmailTransport,
} from "@/lib/email/types";

/**
 * Tiempos y reintentos del envío (H-029). Sin dependencias del servidor: se prueban solos.
 *
 * Un correo que SÍ salió no puede quedar registrado como fallido (el enlace quedaría anulado y un
 * nuevo intento lo duplicaría). Por eso, ante un fallo que se puede repetir (tiempo agotado, red,
 * proveedor caído) se reintenta con la MISMA clave anti-duplicado —el proveedor no manda dos veces
 * lo mismo— mientras quede tiempo; y registrar la confirmación también se reintenta.
 */

/** Intentos de envío con la misma clave anti-duplicado (el primero más uno o dos reintentos). */
export const SEND_MAX_ATTEMPTS = 3;
/** Pausas entre intentos de envío. */
export const SEND_RETRY_DELAYS_MS: readonly number[] = [500, 1_500];
/** Un reintento solo se hace si queda al menos este tiempo para esperar su respuesta. */
export const SEND_MIN_RETRY_WINDOW_MS = 4_000;

/** Intentos para registrar en la base que el correo salió, y sus pausas. */
export const CONFIRM_MAX_ATTEMPTS = 3;
export const CONFIRM_RETRY_DELAYS_MS: readonly number[] = [300, 900];

// Tiempos de la pantalla de enviar. `maxDuration` de la página (valor fijo en `page.tsx`, porque Next
// solo lo lee escrito a mano) y el candado de envío de la base (`app.send_lock_seconds()`) tienen que
// guardar un margen: si el candado vence mientras la acción sigue trabajando, otra pestaña podría
// empezar el mismo envío. Hay una prueba que lee ambos valores de sus archivos.
export const SEND_PAGE_MAX_DURATION_SECONDS = 60;
export const SEND_LOCK_SECONDS = 120;
export const SEND_LOCK_MARGIN_SECONDS = 20;
/** Tiempo que se reserva al final de la acción para confirmar en la base y responder. */
export const SEND_RESERVE_SECONDS = 8;

const MILLISECONDS = 1_000;

/** Momento límite para los intentos de envío, contado desde que empezó la acción. */
export function sendDeadline(startedAtMs: number): number {
  return startedAtMs + (SEND_PAGE_MAX_DURATION_SECONDS - SEND_RESERVE_SECONDS) * MILLISECONDS;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function attempt(
  transport: EmailTransport,
  message: EmailMessage,
  timeoutMs: number,
): Promise<EmailSendResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<EmailSendResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, retryable: true, code: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([transport.send(message), timeout]);
  } catch {
    return { ok: false, retryable: true, code: "network_error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type SendRetryOptions = {
  deadlineMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Envía con tope de espera y reintenta (con la misma clave anti-duplicado del mensaje) si el fallo
 * es repetible y queda tiempo antes de `deadlineMs`. Devuelve el último resultado.
 */
export async function sendWithRetry(
  transport: EmailTransport,
  message: EmailMessage,
  options: SendRetryOptions,
): Promise<EmailSendResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  let result = await attempt(transport, message, SEND_TIMEOUT_MS);
  for (let index = 0; index < SEND_MAX_ATTEMPTS - 1; index += 1) {
    if (result.ok || !result.retryable) return result;
    const pause = SEND_RETRY_DELAYS_MS[index] ?? SEND_RETRY_DELAYS_MS.at(-1) ?? 0;
    const remaining = options.deadlineMs - now() - pause;
    if (remaining < SEND_MIN_RETRY_WINDOW_MS) return result;
    await sleep(pause);
    result = await attempt(transport, message, Math.min(SEND_TIMEOUT_MS, remaining));
  }
  return result;
}

/** Errores de la base que no se arreglan repitiendo la llamada. */
const DEFINITIVE_DB_CODES: ReadonlySet<string> = new Set([
  "42501",
  "CP404",
  "CP409",
  "CP422",
  "CP423",
  "CP429",
]);

export type DbCallResult<T> = { data: T | null; error: { code?: string } | null };

/**
 * Repite una llamada a la base si falló por algo pasajero (sin código o de red/servidor). Las
 * respuestas definitivas (permiso, conflicto, estado) se devuelven tal cual. Las funciones que se
 * usan así son idempotentes: repetir `confirm_email_dispatch` devuelve `already_confirmed`.
 */
export async function retryTransientDb<T>(
  call: () => PromiseLike<DbCallResult<T>>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<DbCallResult<T>> {
  let result = await call();
  for (let index = 0; index < CONFIRM_MAX_ATTEMPTS - 1; index += 1) {
    if (!result.error) return result;
    if (result.error.code && DEFINITIVE_DB_CODES.has(result.error.code)) return result;
    await sleep(CONFIRM_RETRY_DELAYS_MS[index] ?? CONFIRM_RETRY_DELAYS_MS.at(-1) ?? 0);
    result = await call();
  }
  return result;
}
