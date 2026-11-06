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
  reserveInvitationNotices,
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

/** El rol que llegó de la base no es de la matriz: el aviso se cierra como fallido con su propio código. */
class InvalidNoticeRole extends Error {}

type NoticeInfo = NonNullable<Awaited<ReturnType<typeof readInvitationNotice>>["notice"]>;

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
    if (!isMemberRole(info.role)) throw new InvalidNoticeRole();
    const config = loadEmailConfig();
    const built = buildInvitationOwnerNotice({
      recipientAddress: recipient.email,
      fromAddress: config.fromAddress,
      inviterName: info.inviterName ?? "",
      organizationName: info.tenantName,
      roleLabel: ROLE_LABELS[info.role],
      invitedAt: info.invitedAt,
      // Con H-010, «Tu equipo» lista a los miembros: una invitación ya aceptada también se ve ahí.
      invitationAccepted: info.invitationStatus === "accepted",
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
    failureCode =
      cause instanceof InvalidNoticeRole
        ? "invalid_role"
        : cause instanceof EmailConfigError
          ? "email_config"
          : "unexpected";
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
 * Envía el aviso de una invitación cuyo intento YA está reservado (la reserva gastó un intento en la base). Nunca
 * lanza. Sin Dueño con correo, la base lo da por agotado y aquí queda en el log (solo un código).
 */
async function sendReservedNotice(invitationId: string): Promise<void> {
  try {
    const { notice, exhaustedReason } = await readInvitationNotice(invitationId);
    if (exhaustedReason) {
      // Hoy la base solo da un motivo: no hay un Dueño activo con correo.
      await serverLog("error", "invitation_notice_exhausted", { code: "no_recipient" });
    }
    if (!notice) return;
    for (const recipient of notice.recipients) {
      try {
        await noticeOne(invitationId, notice, recipient);
      } catch (cause) {
        await serverLog("warn", "invitation_notice_failed", { code: codeOf(cause) });
      }
    }
  } catch (cause) {
    await serverLog("warn", "invitation_notice_failed", { code: codeOf(cause) });
  }
}

/**
 * El intento inmediato del aviso al Dueño de UNA invitación, justo después de crearla (sin hacer esperar a quien
 * invita). Reserva el intento y lo envía. La garantía NO es este intento: el aviso ya quedó anotado en la base
 * como pendiente y la tarea lo envía y reintenta (en producción, solo cuando se resuelva la decisión #17, cómo se
 * programa la tarea de avisos; mientras tanto, solo corre este intento). Nunca lanza.
 */
export async function notifyOwnerOfInvitation(invitationId: string): Promise<void> {
  try {
    const reserved = await reserveInvitationNotices(1, invitationId);
    if (reserved.exhausted > 0) {
      await serverLog("error", "invitation_notice_exhausted", { code: "max_attempts" });
    }
    if (reserved.invitationIds.includes(invitationId)) await sendReservedNotice(invitationId);
  } catch (cause) {
    await serverLog("warn", "invitation_notice_failed", { code: codeOf(cause) });
  }
}

export type NoticeJobResult = { attended: number; exhausted: number; failed: boolean };

/**
 * La tarea: reserva y envía los avisos al Dueño que quedaron pendientes y reintenta los fallidos (con el tope
 * de intentos y el intervalo mínimo que fija la base). Nunca lanza; `failed` dice que no pudo ni empezar (la base
 * no respondió), para que quien la ejecuta termine con error.
 */
export async function deliverPendingInvitationNotices(
  limit = NOTICE_JOB_BATCH_SIZE,
): Promise<NoticeJobResult> {
  try {
    const reserved = await reserveInvitationNotices(limit);
    if (reserved.exhausted > 0) {
      await serverLog("error", "invitation_notice_exhausted", { code: "max_attempts" });
    }
    for (const invitationId of reserved.invitationIds) await sendReservedNotice(invitationId);
    return {
      attended: reserved.invitationIds.length,
      exhausted: reserved.exhausted,
      failed: false,
    };
  } catch (cause) {
    await serverLog("error", "invitation_notice_job_failed", { code: codeOf(cause) });
    return { attended: 0, exhausted: 0, failed: true };
  }
}
