import { serverLog } from "@/lib/log/server-log";
import { BOUNCE_SIMULATION_DOMAIN } from "../config";
import { simulatedBounce, type DeliveryEvent } from "../delivery-events";
import type { EmailErrorCode, EmailProviderName, EmailSendResult } from "../types";

/** Tope de espera por cada envío (plan del sprint 3, §4). */
export const SEND_TIMEOUT_MS = 15_000;

export function failure(code: EmailErrorCode, retryable: boolean): EmailSendResult {
  return { ok: false, retryable, code };
}

/** `fetch` con tope de tiempo. Devuelve la respuesta, o el código de fallo si no hubo respuesta. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<{ response: Response } | { error: EmailSendResult }> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    return { response };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const isTimeout = name === "TimeoutError" || name === "AbortError";
    return { error: failure(isTimeout ? "timeout" : "network_error", true) };
  }
}

/** Solo códigos y nombre del proveedor: nunca destinatarios, asuntos ni contenido. */
export async function logSendFailure(
  provider: EmailProviderName,
  code: EmailErrorCode,
  status?: number,
): Promise<void> {
  await serverLog("warn", "email_send_failed", { provider, code, status });
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** Rebote simulado para `@rebota.ejemplo.test`: solo lo usan `mailpit` y `memory`. */
export function simulatedEventsFor(
  to: string,
  providerMessageId: string,
): DeliveryEvent[] | undefined {
  return domainOf(to) === BOUNCE_SIMULATION_DOMAIN
    ? [simulatedBounce(providerMessageId)]
    : undefined;
}
