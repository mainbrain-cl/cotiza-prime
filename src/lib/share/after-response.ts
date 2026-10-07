import "server-only";
import { randomUUID } from "node:crypto";
import { loadEmailConfig } from "@/lib/email/config";
import { buildInternalNotice } from "@/lib/email/internal-notice";
import { EmailConfigError, getEmailTransport } from "@/lib/email/transport";
import type { EmailTransport } from "@/lib/email/types";
import { sendWithRetry } from "@/lib/quotes/send/dispatch";
import { getAppOrigin } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { tenantPath } from "@/lib/tenant/constants";
import {
  ShareGatewayError,
  readNoticeRecipients,
  registerInternalNotice,
  settleInternalNotice,
  type NoticeRecipient,
} from "./gateway";
import { reasonLabel } from "./respond";

/**
 * Lo que pasa DESPUÉS de que el cliente respondió (H-031). Nada de esto puede afectar al cliente: la
 * respuesta ya quedó registrada en la base, y si un aviso falla solo se anota un código en el log
 * (nunca el correo, el nombre ni el motivo).
 *
 * A quién se avisa lo decide la base: el autor de la cotización si sigue como miembro activo; si no, el
 * Dueño y los Administradores activos. El correo lleva solo número, decisión y motivo de la lista; el
 * nombre de quien aceptó y el comentario libre se ven dentro de la aplicación.
 */

export type QuoteRespondedInput = {
  tenantId: string;
  quoteId: string;
  numberDisplay: string;
  /** Identificador de la respuesta que la base acaba de registrar. */
  responseId: string;
  decision: "accepted" | "rejected";
  /** Solo en rechazos: el código del motivo de la lista. */
  reasonCode?: string | null;
  /** `true` si el cliente escribió un comentario libre (el correo solo avisa que existe). */
  hasFreeText?: boolean;
};

/** Cuánto se espera, como máximo, para avisar (mismo tope que un envío). */
const NOTICE_DEADLINE_MS = 20_000;
/** Tope de avisos por respuesta: el Dueño y los Administradores nunca son tantos. */
const MAX_NOTICE_RECIPIENTS = 10;

/**
 * Gancho de la aceptación para el correo 2 (datos de transferencia). Se construye en otro sprint.
 * NO crea filas de cobro ni lee nada bancario: hoy no hace nada.
 */
export async function onQuoteAccepted(input: QuoteRespondedInput): Promise<void> {
  // TODO(H-053): correo 2 con los datos de transferencia y el monto a pagar.
  void input;
}

const codeOf = (cause: unknown, fallback = "unexpected"): string =>
  cause instanceof ShareGatewayError
    ? cause.message
    : cause instanceof EmailConfigError
      ? "email_config"
      : fallback;

/** Avisa a un destinatario: lo anota, lo envía y deja el resultado. Nunca lanza. */
async function noticeOne(
  input: QuoteRespondedInput,
  recipient: NoticeRecipient,
  transport: EmailTransport,
  fromAddress: string,
): Promise<void> {
  const emailId = randomUUID();
  let registered = true;
  try {
    await registerInternalNotice({
      emailId,
      tenantId: input.tenantId,
      quoteId: input.quoteId,
      responseId: input.responseId,
      recipient,
    });
  } catch (cause) {
    // Si no se pudo anotar, el aviso igual sale (importa más): solo queda sin fila en el registro.
    registered = false;
    await serverLog("warn", "quote_response_notice_register_failed", { code: codeOf(cause) });
  }

  const built = buildInternalNotice({
    recipientAddress: recipient.email,
    fromAddress,
    quoteNumber: input.numberDisplay,
    decision: input.decision,
    reasonLabel: input.reasonCode ? reasonLabel(input.reasonCode) : null,
    hasFreeText: input.hasFreeText === true,
    quoteUrl: `${getAppOrigin()}${tenantPath(input.tenantId, `cotizaciones/${input.quoteId}`)}`,
    idempotencyKey: emailId,
  });

  let failureCode: string | null = null;
  let sent: { provider: string; providerMessageId: string } | null = null;
  if (!built.ok) {
    failureCode = built.code;
  } else {
    const result = await sendWithRetry(transport, built.message, {
      deadlineMs: Date.now() + NOTICE_DEADLINE_MS,
    });
    if (result.ok) {
      sent = { provider: transport.provider, providerMessageId: result.providerMessageId };
    } else {
      failureCode = result.code;
    }
  }
  if (failureCode) await serverLog("warn", "quote_response_notice_failed", { code: failureCode });

  if (!registered) return;
  try {
    await settleInternalNotice({
      emailId,
      tenantId: input.tenantId,
      ...(sent ? { sent } : { errorCode: failureCode ?? "unknown" }),
    });
  } catch (cause) {
    await serverLog("warn", "quote_response_notice_settle_failed", { code: codeOf(cause) });
  }
}

/** Avisa por correo al equipo que corresponda. Nunca lanza: un fallo se anota solo como código. */
export async function onQuoteResponded(input: QuoteRespondedInput): Promise<void> {
  try {
    const { recipients } = await readNoticeRecipients(input);
    if (recipients.length === 0) {
      await serverLog("warn", "quote_response_notice_skipped", { code: "no_recipients" });
    } else {
      const config = loadEmailConfig();
      const transport = getEmailTransport(config);
      for (const recipient of recipients.slice(0, MAX_NOTICE_RECIPIENTS)) {
        await noticeOne(input, recipient, transport, config.fromAddress);
      }
    }
  } catch (cause) {
    await serverLog("error", "quote_response_notice_failed", { code: codeOf(cause) });
  }
  if (input.decision === "accepted") {
    try {
      await onQuoteAccepted(input);
    } catch {
      await serverLog("error", "quote_accepted_hook_failed");
    }
  }
}
