import "server-only";
import { loadEmailConfig } from "@/lib/email/config";
import { buildInternalNotice } from "@/lib/email/internal-notice";
import { EmailConfigError, getEmailTransport } from "@/lib/email/transport";
import { sendWithRetry } from "@/lib/quotes/send/dispatch";
import { getAppOrigin } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { tenantPath } from "@/lib/tenant/constants";
import { readAuthorEmail } from "./gateway";
import { reasonLabel } from "./respond";

/**
 * Lo que pasa DESPUÉS de que el cliente respondió (H-031). Nada de esto puede afectar al cliente: la
 * respuesta ya quedó registrada en la base, y si un aviso falla solo se anota un código en el log
 * (nunca el correo, el nombre ni el motivo).
 */

export type QuoteRespondedInput = {
  tenantId: string;
  quoteId: string;
  /** Quién creó la cotización: lo informa la base al registrar la respuesta. */
  authorId: string | null;
  numberDisplay: string;
  /** Identificador de la respuesta: es la clave anti-duplicado del correo. */
  responseId: string;
  decision: "accepted" | "rejected";
  acceptorName?: string | null;
  reasonCode?: string | null;
  reasonText?: string | null;
};

/** Cuánto se espera, como máximo, para avisar al autor (mismo tope que un envío). */
const NOTICE_DEADLINE_MS = 20_000;

/**
 * Gancho de la aceptación para el correo 2 (datos de transferencia). Se construye en otro sprint.
 * NO crea filas de cobro ni lee nada bancario: hoy no hace nada.
 */
export async function onQuoteAccepted(input: QuoteRespondedInput): Promise<void> {
  // TODO(H-053): correo 2 con los datos de transferencia y el monto a pagar.
  void input;
}

/** Avisa por correo al autor de la cotización. Nunca lanza: un fallo se anota solo como código. */
export async function onQuoteResponded(input: QuoteRespondedInput): Promise<void> {
  try {
    const authorEmail = await readAuthorEmail(input.authorId);
    if (!authorEmail) {
      await serverLog("warn", "quote_response_notice_skipped", { code: "no_author_email" });
    } else {
      const config = loadEmailConfig();
      const built = buildInternalNotice({
        recipientAddress: authorEmail,
        fromAddress: config.fromAddress,
        quoteNumber: input.numberDisplay,
        decision: input.decision,
        acceptorName: input.acceptorName,
        reasonLabel: input.reasonCode ? reasonLabel(input.reasonCode) : null,
        reasonText: input.reasonText,
        quoteUrl: `${getAppOrigin()}${tenantPath(input.tenantId, `cotizaciones/${input.quoteId}`)}`,
        idempotencyKey: input.responseId,
      });
      if (!built.ok) {
        await serverLog("warn", "quote_response_notice_failed", { code: built.code });
      } else {
        const sent = await sendWithRetry(getEmailTransport(config), built.message, {
          deadlineMs: Date.now() + NOTICE_DEADLINE_MS,
        });
        if (!sent.ok) await serverLog("warn", "quote_response_notice_failed", { code: sent.code });
      }
    }
  } catch (cause) {
    const code = cause instanceof EmailConfigError ? "email_config" : "unexpected";
    await serverLog("error", "quote_response_notice_failed", { code });
  }
  if (input.decision === "accepted") {
    try {
      await onQuoteAccepted(input);
    } catch {
      await serverLog("error", "quote_accepted_hook_failed");
    }
  }
}
