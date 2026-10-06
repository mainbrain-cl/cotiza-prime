import "server-only";
import { z } from "zod";
import { serverLog } from "@/lib/log/server-log";
import { createMailpitTransport } from "./adapters/mailpit";
import { createMemoryTransport } from "./adapters/memory";
import { createResendTransport } from "./adapters/resend";
import { domainOf, failure } from "./adapters/shared";
import { EmailConfigError, loadEmailConfig, type EmailConfig } from "./config";
import type { EmailMessage, EmailSendResult, EmailTransport } from "./types";
import { HEADER_UNSAFE } from "./unsafe-characters";

const MAX_SUBJECT_LENGTH = 150;
const MAX_ADDRESS_LENGTH = 254;
const MAX_ATTACHMENTS = 5;
const MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_HTML_LENGTH = 500_000;
// Cualquier carácter de control (incluye CR y LF): en cabeceras abre la puerta a inyectar otras.
const CONTROL_CHARACTERS = HEADER_UNSAFE;
const emailSchema = z.email().max(MAX_ADDRESS_LENGTH);

function isValidMessage(message: EmailMessage): boolean {
  const headerValues = [message.subject, message.from.name, message.from.address, message.to];
  if (headerValues.some((value) => CONTROL_CHARACTERS.test(value))) return false;
  if (message.subject.length === 0 || message.subject.length > MAX_SUBJECT_LENGTH) return false;
  if (message.from.name.length === 0 || /[<>"]/.test(message.from.name)) return false;
  if (!emailSchema.safeParse(message.from.address).success) return false;
  if (!emailSchema.safeParse(message.to).success) return false;
  if (message.replyTo !== undefined) {
    if (CONTROL_CHARACTERS.test(message.replyTo)) return false;
    if (!emailSchema.safeParse(message.replyTo).success) return false;
  }
  if (message.html.length > MAX_HTML_LENGTH) return false;
  const attachments = message.attachments ?? [];
  if (attachments.length > MAX_ATTACHMENTS) return false;
  let total = 0;
  for (const attachment of attachments) {
    if (CONTROL_CHARACTERS.test(attachment.filename) || /[\\/"]/.test(attachment.filename)) {
      return false;
    }
    total += attachment.content.byteLength;
  }
  return total <= MAX_TOTAL_ATTACHMENT_BYTES;
}

/**
 * Envuelve cualquier adaptador con las reglas que no dependen del proveedor: el mensaje tiene que
 * ser válido y, fuera de producción, el destinatario tiene que estar en la lista blanca (así una
 * prueba nunca le escribe a una persona real). Nunca se registra el correo ni su contenido.
 */
export function withSendGuards(inner: EmailTransport, config: EmailConfig): EmailTransport {
  return {
    provider: inner.provider,
    async send(message: EmailMessage): Promise<EmailSendResult> {
      if (!isValidMessage(message)) {
        await serverLog("warn", "email_send_blocked", {
          provider: inner.provider,
          code: "invalid_message",
        });
        return failure("invalid_message", false);
      }
      const allowed = config.allowedRecipientDomains;
      if (allowed && !allowed.includes(domainOf(message.to))) {
        await serverLog("warn", "email_send_blocked", {
          provider: inner.provider,
          code: "recipient_not_allowed",
        });
        return failure("recipient_not_allowed", false);
      }
      return inner.send(message);
    },
  };
}

/** Elige el adaptador según `EMAIL_PROVIDER`. Lanza `EmailConfigError` si la configuración no sirve. */
export function getEmailTransport(config: EmailConfig = loadEmailConfig()): EmailTransport {
  let inner: EmailTransport;
  switch (config.provider) {
    case "mailpit":
      inner = createMailpitTransport(config.mailpitApiUrl);
      break;
    case "memory":
      inner = createMemoryTransport();
      break;
    case "resend":
      if (!config.resendApiKey) throw new EmailConfigError("Falta RESEND_API_KEY.");
      inner = createResendTransport(config.resendApiKey);
      break;
    case "smtp":
      // Sin dependencia nueva no hay cliente SMTP: se deja explícito en vez de fallar en silencio.
      throw new EmailConfigError(
        "El envío por SMTP no está configurado todavía: usa EMAIL_PROVIDER=resend (o mailpit en desarrollo).",
      );
  }
  return withSendGuards(inner, config);
}

export { EmailConfigError };
