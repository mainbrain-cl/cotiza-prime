import "server-only";
import { randomUUID } from "node:crypto";
import { loadEmailConfig } from "@/lib/email/config";
import { buildIntakeNotice } from "@/lib/email/intake-notice";
import { EmailConfigError, getEmailTransport } from "@/lib/email/transport";
import { getAppOrigin } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { sendWithRetry } from "@/lib/quotes/send/dispatch";
import { tenantPath } from "@/lib/tenant/constants";
import {
  IntakeGatewayError,
  readIntakeNoticeRecipients,
  registerIntakeNotice,
  settleIntakeNotice,
} from "./gateway";

/**
 * «Te asignaron una solicitud» (H-089). Se envía DESPUÉS de que la asignación quedó guardada y nunca
 * la bloquea: si algo falla solo se anota un código en el log (jamás un correo, un nombre ni un
 * identificador). A quién se avisa lo decide la base: la persona asignada si sigue activa o, si no, el
 * Dueño y los Administradores. El correo solo lleva el nombre del formulario y un botón hacia la
 * solicitud; nada de lo que escribió el visitante. Cada aviso queda en `email_messages`.
 */

const NOTICE_DEADLINE_MS = 20_000;
const MAX_NOTICE_RECIPIENTS = 10;

const codeOf = (cause: unknown): string =>
  cause instanceof IntakeGatewayError
    ? cause.message
    : cause instanceof EmailConfigError
      ? "email_config"
      : "unexpected";

/** Nunca lanza. */
export async function notifyRequestAssigned(requestId: string): Promise<void> {
  try {
    const info = await readIntakeNoticeRecipients({ kind: "request_assigned", requestId });
    if (info.recipients.length === 0) {
      await serverLog("warn", "intake_notice_skipped", { code: "no_recipients" });
      return;
    }
    const config = loadEmailConfig();
    const transport = getEmailTransport(config);
    for (const recipient of info.recipients.slice(0, MAX_NOTICE_RECIPIENTS)) {
      const emailId = randomUUID();
      try {
        const registration = await registerIntakeNotice({
          emailId,
          tenantId: info.tenantId,
          kind: "request_assigned",
          requestId,
          recipient,
        });
        if (!registration.registered) {
          await serverLog("warn", "intake_notice_not_registered", { code: registration.reason });
          continue;
        }
      } catch (cause) {
        await serverLog("warn", "intake_notice_register_failed", { code: codeOf(cause) });
        continue;
      }

      const built = buildIntakeNotice({
        kind: "request_assigned",
        recipientAddress: recipient.email,
        fromAddress: config.fromAddress,
        formName: info.formName,
        appUrl: `${getAppOrigin()}${tenantPath(info.tenantId, `solicitudes/${requestId}`)}`,
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
      if (failureCode) await serverLog("warn", "intake_notice_failed", { code: failureCode });
      try {
        await settleIntakeNotice({
          emailId,
          ...(sent ? { sent } : { errorCode: failureCode ?? "unknown" }),
        });
      } catch (cause) {
        await serverLog("warn", "intake_notice_settle_failed", { code: codeOf(cause) });
      }
    }
  } catch (cause) {
    await serverLog("error", "intake_notice_failed", { code: codeOf(cause) });
  }
}
