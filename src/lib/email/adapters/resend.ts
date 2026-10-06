import type { EmailMessage, EmailSendResult, EmailTransport } from "../types";
import { failure, fetchWithTimeout, logSendFailure, toBase64 } from "./shared";

const RESEND_SEND_URL = "https://api.resend.com/emails";
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const STATUS_RATE_LIMITED = 429;
const STATUS_CONFLICT = 409;
const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;
const SERVER_ERROR_FROM = 500;
/** Nombre de error de Resend cuando dos envíos con la misma clave van a la vez. */
const CONCURRENT_IDEMPOTENCY = "concurrent_idempotent_requests";

type FetchLike = typeof fetchWithTimeout;

/** Resend por `fetch` directo (sin su librería). Soporta clave anti-duplicado. */
export function createResendTransport(
  apiKey: string,
  doFetch: FetchLike = fetchWithTimeout,
  url: string = RESEND_SEND_URL,
): EmailTransport {
  return {
    provider: "resend",
    async send(message: EmailMessage): Promise<EmailSendResult> {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      if (message.idempotencyKey) {
        headers["Idempotency-Key"] = message.idempotencyKey.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
      }
      const body = {
        from: `${message.from.name} <${message.from.address}>`,
        to: [message.to],
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        subject: message.subject,
        html: message.html,
        text: message.text,
        attachments: (message.attachments ?? []).map((attachment) => ({
          filename: attachment.filename,
          content: toBase64(attachment.content),
        })),
      };
      const result = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      if ("error" in result) {
        if (!result.error.ok) await logSendFailure("resend", result.error.code);
        return result.error;
      }
      const { response } = result;
      const status = response.status;

      if (!response.ok) {
        let outcome: EmailSendResult;
        if (status === STATUS_RATE_LIMITED) outcome = failure("rate_limited", true);
        else if (status >= SERVER_ERROR_FROM) outcome = failure("provider_unavailable", true);
        else if (status === STATUS_UNAUTHORIZED || status === STATUS_FORBIDDEN) {
          outcome = failure("provider_auth", false);
        } else if (status === STATUS_CONFLICT) {
          let name: unknown;
          try {
            name = ((await response.json()) as { name?: unknown }).name;
          } catch {
            name = undefined;
          }
          outcome = failure("provider_conflict", name === CONCURRENT_IDEMPOTENCY);
        } else outcome = failure("provider_rejected", false);
        if (!outcome.ok) await logSendFailure("resend", outcome.code, status);
        return outcome;
      }

      let id: unknown;
      try {
        id = ((await response.json()) as { id?: unknown }).id;
      } catch {
        id = undefined;
      }
      if (typeof id !== "string" || id.length === 0) {
        // Resend aceptó pero no devolvió id: no se puede seguir el correo. Se trata como incierto.
        await logSendFailure("resend", "provider_unavailable", status);
        return failure("provider_unavailable", true);
      }
      return { ok: true, providerMessageId: id };
    },
  };
}
