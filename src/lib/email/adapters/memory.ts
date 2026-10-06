import { randomUUID } from "node:crypto";
import type { EmailMessage, EmailSendResult, EmailTransport } from "../types";
import { simulatedEventsFor } from "./shared";

/** Correos "enviados" en memoria. Solo para pruebas: nunca sale nada a la red. */
const outbox: Array<{ providerMessageId: string; message: EmailMessage }> = [];
const idempotent = new Map<string, string>();

export function getMemoryOutbox(): ReadonlyArray<{
  providerMessageId: string;
  message: EmailMessage;
}> {
  return outbox;
}

export function resetMemoryOutbox(): void {
  outbox.length = 0;
  idempotent.clear();
}

export function createMemoryTransport(): EmailTransport {
  return {
    provider: "memory",
    async send(message: EmailMessage): Promise<EmailSendResult> {
      const key = message.idempotencyKey;
      const previous = key ? idempotent.get(key) : undefined;
      if (previous) return { ok: true, providerMessageId: previous };

      const providerMessageId = `memory-${randomUUID()}`;
      outbox.push({ providerMessageId, message });
      if (key) idempotent.set(key, providerMessageId);
      return {
        ok: true,
        providerMessageId,
        simulatedEvents: simulatedEventsFor(message.to, providerMessageId),
      };
    },
  };
}
