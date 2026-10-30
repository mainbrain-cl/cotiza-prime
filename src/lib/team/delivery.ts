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

/**
 * Avisa al Dueño que alguien que no lo es invitó a un Administrador. Se llama DESPUÉS de crear la invitación
 * (ya confirmada en la base) y NUNCA lanza: si algo falla solo se anota un código en el log y la invitación
 * queda igual. La base decide a quién avisar y entrega los datos; el aviso no lleva el correo del invitado.
 */
export async function notifyOwnerOfInvitation(invitationId: string): Promise<void> {
  try {
    const info = await readInvitationNotice(invitationId);
    if (!info || !isMemberRole(info.role)) return;
    const config = loadEmailConfig();
    const transport = getEmailTransport(config);
    for (const recipient of info.recipients) {
      const emailId = randomUUID();
      const registered = await registerInvitationNotice({
        emailId,
        invitationId,
        tenantId: info.tenantId,
        recipient,
      });
      if (!registered) continue;
      let failureCode: string | null = null;
      let sent: { provider: string; providerMessageId: string } | null = null;
      const built = buildInvitationOwnerNotice({
        recipientAddress: recipient.email,
        fromAddress: config.fromAddress,
        inviterName: info.inviterName ?? "Un miembro del equipo",
        organizationName: info.tenantName,
        roleLabel: ROLE_LABELS[info.role],
        invitedAt: info.invitedAt,
        teamUrl: `${getAppOrigin()}${tenantPath(info.tenantId, "equipo")}`,
        idempotencyKey: emailId,
      });
      if (!built.ok) {
        failureCode = built.code;
      } else {
        const result = await sendWithRetry(transport, built.message, {
          deadlineMs: Date.now() + SEND_DEADLINE_MS,
        });
        if (result.ok) {
          sent = { provider: transport.provider, providerMessageId: result.providerMessageId };
        } else {
          failureCode = result.code;
        }
      }
      if (failureCode) await serverLog("warn", "invitation_notice_failed", { code: failureCode });
      try {
        await settleInvitationEmail({
          emailId,
          ...(sent ? { sent } : { errorCode: failureCode ?? "unknown" }),
        });
      } catch (cause) {
        await serverLog("warn", "invitation_notice_settle_failed", { code: codeOf(cause) });
      }
    }
  } catch (cause) {
    await serverLog("warn", "invitation_notice_failed", { code: codeOf(cause) });
  }
}
