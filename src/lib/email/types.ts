/**
 * Contrato común de la capa de correo (decisión 016). Cada proveedor es un adaptador que cumple
 * `EmailTransport`; el resto de la aplicación nunca habla con un proveedor directamente.
 */
import type { DeliveryEvent } from "./delivery-events";

export const EMAIL_PROVIDERS = ["mailpit", "memory", "resend", "smtp"] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];

export type EmailAddress = {
  /** Nombre visible, ya limpio (sin comillas, saltos de línea ni `<`, `>`, `@`). */
  name: string;
  address: string;
};

export type EmailAttachment = {
  filename: string;
  contentType: string;
  content: Uint8Array;
};

export type EmailMessage = {
  from: EmailAddress;
  /** Un solo destinatario por mensaje: cada correo queda registrado y se sigue por separado. */
  to: string;
  /** Dirección a la que llegan las respuestas del cliente (contacto de la organización o del autor). */
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
  /**
   * Clave anti-duplicado: si el envío se repite con la misma clave, el proveedor (cuando lo
   * soporta) no manda el correo dos veces. Normalmente es el id del registro del correo.
   */
  idempotencyKey?: string;
};

/** Códigos de fallo: son lo único que se registra en los logs, nunca el correo ni su contenido. */
export const EMAIL_ERROR_CODES = [
  "invalid_message",
  "recipient_not_allowed",
  "timeout",
  "network_error",
  "rate_limited",
  "provider_unavailable",
  "provider_rejected",
  "provider_auth",
  "provider_conflict",
] as const;
export type EmailErrorCode = (typeof EMAIL_ERROR_CODES)[number];

export type EmailSendResult =
  | {
      ok: true;
      providerMessageId: string;
      /**
       * Solo en `mailpit` y `memory` (nunca en producción): avisos de entrega que el proveedor real
       * mandaría después por el webhook y que aquí se simulan (rebote para `@rebota.ejemplo.test`).
       */
      simulatedEvents?: DeliveryEvent[];
    }
  | { ok: false; retryable: boolean; code: EmailErrorCode };

export interface EmailTransport {
  readonly provider: EmailProviderName;
  send(message: EmailMessage): Promise<EmailSendResult>;
}
