import type { EmailMessage, EmailSendResult, EmailTransport } from "../types";
import { failure, fetchWithTimeout, logSendFailure, simulatedEventsFor, toBase64 } from "./shared";

const SEND_PATH = "/api/v1/send";

/** Adaptador para desarrollo y pruebas: Mailpit local. Mailpit no soporta clave anti-duplicado. */
export function createMailpitTransport(apiUrl: string): EmailTransport {
  return {
    provider: "mailpit",
    async send(message: EmailMessage): Promise<EmailSendResult> {
      const body = {
        From: { Email: message.from.address, Name: message.from.name },
        To: [{ Email: message.to }],
        Subject: message.subject,
        HTML: message.html,
        Text: message.text,
        Attachments: (message.attachments ?? []).map((attachment) => ({
          Filename: attachment.filename,
          Content: toBase64(attachment.content),
          ContentType: attachment.contentType,
        })),
      };
      const result = await fetchWithTimeout(`${apiUrl}${SEND_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if ("error" in result) {
        if (!result.error.ok) await logSendFailure("mailpit", result.error.code);
        return result.error;
      }
      const { response } = result;
      if (!response.ok) {
        const code = response.status >= 500 ? "provider_unavailable" : "provider_rejected";
        await logSendFailure("mailpit", code, response.status);
        return failure(code, response.status >= 500);
      }
      let id: unknown;
      try {
        id = ((await response.json()) as { ID?: unknown }).ID;
      } catch {
        id = undefined;
      }
      if (typeof id !== "string" || id.length === 0) {
        await logSendFailure("mailpit", "provider_rejected", response.status);
        return failure("provider_rejected", false);
      }
      return {
        ok: true,
        providerMessageId: id,
        simulatedEvents: simulatedEventsFor(message.to, id),
      };
    },
  };
}
