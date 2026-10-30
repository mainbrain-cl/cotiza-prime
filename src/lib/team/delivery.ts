import "server-only";
import { loadEmailConfig } from "@/lib/email/config";
import { buildInvitationEmail } from "@/lib/email/invitation";
import { EmailConfigError, getEmailTransport } from "@/lib/email/transport";
import { getAppOrigin } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, isMemberRole } from "@/lib/permissions/matrix";
import { sendWithRetry } from "@/lib/quotes/send/dispatch";
import { TeamGatewayError, settleInvitationEmail } from "./gateway";
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
