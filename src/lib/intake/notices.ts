import "server-only";
import { randomUUID } from "node:crypto";
import { loadEmailConfig } from "@/lib/email/config";
import { buildIntakeNotice } from "@/lib/email/intake-notice";
import { EmailConfigError, getEmailTransport } from "@/lib/email/transport";
import type { EmailTransport } from "@/lib/email/types";
import { getAppOrigin } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { sendWithRetry } from "@/lib/quotes/send/dispatch";
import { tenantPath } from "@/lib/tenant/constants";
import {
  IntakeGatewayError,
  readIntakeNoticeRecipients,
  registerIntakeNotice,
  settleIntakeNotice,
  type IntakeNoticeRecipient,
} from "./gateway";

/**
 * Lo que pasa DESPUÉS de que una solicitud quedó guardada (H-087): avisarle al equipo. Nada de esto puede
 * afectar al visitante: la solicitud ya está en la base, y si un aviso falla solo se anota un código en el
 * log (nunca un correo, un nombre ni el identificador del formulario).
 *
 * A quién se avisa lo decide la base (Dueño y Administradores activos; «Llegó una solicitud» con tope de 20
 * al día por organización). Si la base responde que el aviso no se registró, el correo NO se envía. El
 * correo no lleva datos del visitante. No hay correo automático al visitante.
 */

/** Cuánto se espera, como máximo, para avisar. */
const NOTICE_DEADLINE_MS = 20_000;
/** Tope de avisos por evento: el Dueño y los Administradores nunca son tantos. */
const MAX_NOTICE_RECIPIENTS = 10;

type Target =
  | { kind: "request_received"; requestId: string }
  | { kind: "intake_cap_reached"; formId: string; capKind: "form" | "org" };

const codeOf = (cause: unknown, fallback = "unexpected"): string =>
  cause instanceof IntakeGatewayError
    ? cause.message
    : cause instanceof EmailConfigError
      ? "email_config"
      : fallback;

/** Avisa a un destinatario: lo anota, lo envía y deja el resultado. Nunca lanza. */
async function noticeOne(
  target: Target,
  context: { tenantId: string; formId: string; formName: string },
  recipient: IntakeNoticeRecipient,
  transport: EmailTransport,
  fromAddress: string,
): Promise<void> {
  const emailId = randomUUID();
  try {
    const registration = await registerIntakeNotice({
      emailId,
      tenantId: context.tenantId,
      kind: target.kind,
      requestId: target.kind === "request_received" ? target.requestId : undefined,
      formId: context.formId,
      recipient,
    });
    if (!registration.registered) {
      await serverLog("warn", "intake_notice_not_registered", { code: registration.reason });
      return;
    }
  } catch (cause) {
    // Sin registro no hay tope ni rastro: el aviso no sale.
    await serverLog("warn", "intake_notice_register_failed", { code: codeOf(cause) });
    return;
  }

  const appPath =
    target.kind === "request_received"
      ? tenantPath(context.tenantId, "solicitudes")
      : tenantPath(context.tenantId, `formularios/${context.formId}`);
  const built = buildIntakeNotice({
    recipientAddress: recipient.email,
    fromAddress,
    formName: context.formName,
    appUrl: `${getAppOrigin()}${appPath}`,
    idempotencyKey: emailId,
    ...(target.kind === "request_received"
      ? { kind: "request_received" as const }
      : { kind: "intake_cap_reached" as const, capKind: target.capKind }),
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

async function notify(target: Target): Promise<void> {
  try {
    const info = await readIntakeNoticeRecipients(
      target.kind === "request_received"
        ? { kind: "request_received", requestId: target.requestId }
        : { kind: "intake_cap_reached", formId: target.formId },
    );
    if (info.limited || info.recipients.length === 0) {
      await serverLog("warn", "intake_notice_skipped", {
        code: info.limited ? "daily_limit" : "no_recipients",
      });
      return;
    }
    const config = loadEmailConfig();
    const transport = getEmailTransport(config);
    for (const recipient of info.recipients.slice(0, MAX_NOTICE_RECIPIENTS)) {
      await noticeOne(target, info, recipient, transport, config.fromAddress);
    }
  } catch (cause) {
    await serverLog("error", "intake_notice_failed", { code: codeOf(cause) });
  }
}

/** «Llegó una solicitud»: al Dueño y los Administradores activos. Nunca lanza. */
export function notifyRequestReceived(requestId: string): Promise<void> {
  return notify({ kind: "request_received", requestId });
}

/** «Tu formulario llegó al tope de hoy» (o el de la organización). Nunca lanza. */
export function notifyCapReached(formId: string, capKind: "form" | "org"): Promise<void> {
  return notify({ kind: "intake_cap_reached", formId, capKind });
}
