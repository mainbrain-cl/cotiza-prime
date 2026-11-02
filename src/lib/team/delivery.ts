import "server-only";
import { loadEmailConfig } from "@/lib/email/config";
import { randomUUID } from "node:crypto";
import { buildInvitationEmail } from "@/lib/email/invitation";
import { buildInvitationOwnerNotice } from "@/lib/email/invitation-owner-notice";
import { EmailConfigError, getEmailTransport } from "@/lib/email/transport";
import { getAppOrigin } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, isMemberRole } from "@/lib/permissions/matrix";
import { sendWithRetry } from "@/lib/quotes/send/dispatch";
import { tenantPath } from "@/lib/tenant/constants";
import {
  TeamGatewayError,
  listPendingInvitationNotices,
  readInvitationNotice,
  registerInvitationNotice,
  settleInvitationEmail,
} from "./gateway";
import { invitationUrl } from "./invitation-code";

/** Cuánto se espera, como máximo, para enviar el correo de una invitación. */
const SEND_DEADLINE_MS = 20_000;

const codeOf = (cause: unknown): string =>
  cause instanceof TeamGatewayError
    ? cause.message
    : cause instanceof EmailConfigError
      ? "email_config"
      : "unexpected";

export type InvitationDelivery = {
  emailId: string;
  recipientAddress: string;
  inviterName: string;
  organizationName: string;
  role: string;
  expiresAt: string;
  /** El código del enlace. Sale solo en el correo: no se registra, no se guarda, no va a ningún log. */
  token: string;
};

/**
 * Envía el correo de una invitación y deja el resultado en el registro de correos (enviado o fallido).
 * NUNCA lanza: si algo falla, la invitación queda «pendiente, no enviada» y se puede reenviar desde la
 * pantalla. Solo se anotan códigos en el log (jamás el correo, el nombre ni el código del enlace).
 * Devuelve `true` si el proveedor aceptó el correo.
 */
export async function deliverInvitationEmail(input: InvitationDelivery): Promise<boolean> {
  let failureCode: string | null = null;
  let sent: { provider: string; providerMessageId: string } | null = null;
  try {
    if (!isMemberRole(input.role)) {
      failureCode = "invalid_input";
    } else {
      const config = loadEmailConfig();
      const built = buildInvitationEmail({
        recipientAddress: input.recipientAddress,
        fromAddress: config.fromAddress,
        inviterName: input.inviterName,
        organizationName: input.organizationName,
        roleLabel: ROLE_LABELS[input.role],
        roleDescription: ROLE_DESCRIPTIONS[input.role],
        expiresAt: input.expiresAt,
        inviteUrl: invitationUrl(getAppOrigin(), input.token),
        idempotencyKey: input.emailId,
      });
      if (!built.ok) {
        failureCode = built.code;
      } else {
        const transport = getEmailTransport(config);
        const result = await sendWithRetry(transport, built.message, {
          deadlineMs: Date.now() + SEND_DEADLINE_MS,
        });
        if (result.ok) {
          sent = { provider: transport.provider, providerMessageId: result.providerMessageId };
        } else {
          failureCode = result.code;
        }
      }
    }
  } catch (cause) {
    failureCode = codeOf(cause);
  }
  if (failureCode) await serverLog("warn", "invitation_email_failed", { code: failureCode });

  try {
    await settleInvitationEmail({
      emailId: input.emailId,
      ...(sent ? { sent } : { errorCode: failureCode ?? "unknown" }),
    });
  } catch (cause) {
    await serverLog("warn", "invitation_email_settle_failed", { code: codeOf(cause) });
  }
  return sent !== null;
}

/** Cuántos avisos atiende cada corrida de la tarea. */
export const NOTICE_JOB_BATCH_SIZE = 20;

type NoticeInfo = NonNullable<Awaited<ReturnType<typeof readInvitationNotice>>>;

/**
 * Un intento de aviso a UN destinatario. Una vez anotado el intento en la base, SIEMPRE se cierra (enviado o
 * fallido): lo que falle entre medias (armar el correo, leer la dirección de la aplicación, el proveedor) queda
 * como un código, nunca como un registro «pendiente» para siempre.
 */
async function noticeOne(
  invitationId: string,
  info: NoticeInfo,
  recipient: NoticeInfo["recipients"][number],
): Promise<void> {
  const emailId = randomUUID();
  const registered = await registerInvitationNotice({
    emailId,
    invitationId,
    tenantId: info.tenantId,
    recipient,
  });
  if (!registered) return;

  let failureCode: string | null = null;
  let sent: { provider: string; providerMessageId: string } | null = null;
  try {
    if (!isMemberRole(info.role)) throw new Error("invalid_role");
    const config = loadEmailConfig();
    const built = buildInvitationOwnerNotice({
      recipientAddress: recipient.email,
      fromAddress: config.fromAddress,
      inviterName: info.inviterName ?? "",
      organizationName: info.tenantName,
      roleLabel: ROLE_LABELS[info.role],
      invitedAt: info.invitedAt,
      teamUrl: `${getAppOrigin()}${tenantPath(info.tenantId, "equipo")}`,
      idempotencyKey: emailId,
    });
    if (!built.ok) {
      failureCode = built.code;
    } else {
      const transport = getEmailTransport(config);
      const result = await sendWithRetry(transport, built.message, {
        deadlineMs: Date.now() + SEND_DEADLINE_MS,
      });
      if (result.ok) {
        sent = { provider: transport.provider, providerMessageId: result.providerMessageId };
      } else {
        failureCode = result.code;
      }
    }
  } catch (cause) {
    failureCode = cause instanceof EmailConfigError ? "email_config" : "unexpected";
  }
  if (failureCode) await serverLog("warn", "invitation_notice_failed", { code: failureCode });
  try {
    const closed = await settleInvitationEmail({
      emailId,
      ...(sent ? { sent } : { errorCode: failureCode ?? "unknown" }),
    });
    // Se agotaron los intentos: el aviso no se va a reintentar más. Queda a la vista en el log (solo un código).
    if (!sent && closed.exhausted) {
      await serverLog("error", "invitation_notice_exhausted", { code: "max_attempts" });
    }
  } catch (cause) {
    await serverLog("warn", "invitation_notice_settle_failed", { code: codeOf(cause) });
  }
}

/**
 * Intenta el aviso al Dueño de UNA invitación. Es el intento inmediato (después de crearla, sin hacer esperar a
 * quien invita) y también lo que usa la tarea. La garantía NO es este intento: el aviso ya quedó anotado en la
 * base como pendiente y la tarea lo envía y reintenta. Nunca lanza.
 */
export async function notifyOwnerOfInvitation(invitationId: string): Promise<void> {
  try {
    const info = await readInvitationNotice(invitationId);
    if (!info) return;
    for (const recipient of info.recipients) {
      try {
        await noticeOne(invitationId, info, recipient);
      } catch (cause) {
        await serverLog("warn", "invitation_notice_failed", { code: codeOf(cause) });
      }
    }
  } catch (cause) {
    await serverLog("warn", "invitation_notice_failed", { code: codeOf(cause) });
  }
}

/**
 * La tarea: envía los avisos al Dueño que quedaron pendientes y reintenta los fallidos (con el tope de intentos
 * y el intervalo mínimo que fija la base). Nunca lanza; devuelve cuántas invitaciones atendió y cuántos avisos
 * acaban de agotar sus intentos.
 */
export async function deliverPendingInvitationNotices(
  limit = NOTICE_JOB_BATCH_SIZE,
): Promise<{ attended: number; exhausted: number }> {
  try {
    const pending = await listPendingInvitationNotices(limit);
    if (pending.exhausted > 0) {
      await serverLog("error", "invitation_notice_exhausted", { code: "max_attempts" });
    }
    for (const invitationId of pending.invitationIds) await notifyOwnerOfInvitation(invitationId);
    return { attended: pending.invitationIds.length, exhausted: pending.exhausted };
  } catch (cause) {
    await serverLog("error", "invitation_notice_job_failed", { code: codeOf(cause) });
    return { attended: 0, exhausted: 0 };
  }
}
