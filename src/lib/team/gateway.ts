import "server-only";
import { z } from "zod";
import { encryptPii } from "@/lib/crypto/pii";
import { searchHash } from "@/lib/crypto/search-hash";
import { normalizeEmail } from "@/lib/normalize/email";
import { createAdminClient } from "@/lib/supabase/admin-client";

/**
 * El PORTERO de las invitaciones (H-008). Es el único archivo de `src/lib/team/` que usa la llave maestra y
 * llama a TRES funciones de la base, todas solo del servidor:
 *  - `invitation_email_settle`: cierra el registro del correo de una invitación o de su aviso (enviado, con lo
 *    que informó el proveedor; o fallido, con un código sin datos personales);
 *  - `invitation_notice_recipients` e `invitation_notice_register`: el aviso al Dueño cuando alguien que no es
 *    el Dueño invita a un Administrador. La base decide a quién avisar y qué datos van; el aviso nunca lleva el
 *    correo del invitado.
 *
 * Por qué hace falta: ninguna persona con pase puede escribir en `email_messages` (es un registro de solo
 * agregar que anota lo que el proveedor de correo respondió), así que lo cierra el servidor, igual que en el
 * aviso interno de una cotización (`internal_notice_settle`).
 *
 * No toca ninguna tabla ni la API de cuentas (una guardia estática lo vigila). Invitar, reenviar y cancelar NO
 * usan la llave maestra: corren con el pase de la persona y la base revisa su permiso.
 */

export class TeamGatewayError extends Error {
  constructor(operation: string, code?: string) {
    super(`team_gateway_${operation}${code ? `:${code}` : ""}`);
    this.name = "TeamGatewayError";
  }
}

/** Cierra el correo de una invitación: enviado (con lo que informó el proveedor) o fallido (solo un código). */
export async function settleInvitationEmail(input: {
  emailId: string;
  sent?: { provider: string; providerMessageId: string };
  errorCode?: string;
}): Promise<void> {
  const { error } = await createAdminClient().rpc("invitation_email_settle", {
    p_email_id: input.emailId,
    p_provider: input.sent?.provider ?? null,
    p_provider_message_id: input.sent?.providerMessageId ?? null,
    p_error_code: input.sent ? null : (input.errorCode ?? "unknown"),
  });
  if (error) throw new TeamGatewayError("settle", error.code);
}

const recipientsSchema = z.object({
  tenant_id: z.uuid().optional(),
  tenant_name: z.string().optional(),
  inviter_name: z.string().nullable().optional(),
  role: z.string().optional(),
  invited_at: z.string().optional(),
  recipients: z.array(z.object({ user_id: z.uuid(), email: z.string().min(3).max(254) })).max(10),
});

export type InvitationNoticeInfo = {
  tenantId: string;
  tenantName: string;
  inviterName: string | null;
  role: string;
  invitedAt: string;
  recipients: { userId: string; email: string }[];
};

/**
 * A quién avisar de una invitación y con qué datos, ya filtrados por la base. Si no corresponde avisar (o ya se
 * avisó), `null`. La base no entrega el correo del invitado.
 */
export async function readInvitationNotice(
  invitationId: string,
): Promise<InvitationNoticeInfo | null> {
  const { data, error } = await createAdminClient().rpc("invitation_notice_recipients", {
    p_invitation_id: invitationId,
  });
  if (error) throw new TeamGatewayError("notice_recipients", error.code);
  const parsed = recipientsSchema.safeParse(data);
  if (!parsed.success) throw new TeamGatewayError("notice_recipients", "shape");
  const body = parsed.data;
  if (body.recipients.length === 0) return null;
  if (!body.tenant_id || !body.tenant_name || !body.role || !body.invited_at) {
    throw new TeamGatewayError("notice_recipients", "shape");
  }
  return {
    tenantId: body.tenant_id,
    tenantName: body.tenant_name,
    inviterName: body.inviter_name ?? null,
    role: body.role,
    invitedAt: body.invited_at,
    recipients: body.recipients.map((r) => ({ userId: r.user_id, email: r.email })),
  };
}

/**
 * Anota el aviso (antes de enviarlo) en el registro de correos, con el correo del Dueño cifrado y su huella.
 * Si la base responde `registered: false` (ya se avisó, o ya no corresponde), el correo NO se envía.
 */
export async function registerInvitationNotice(input: {
  emailId: string;
  invitationId: string;
  tenantId: string;
  recipient: { userId: string; email: string };
}): Promise<boolean> {
  const email = normalizeEmail(input.recipient.email);
  const { data, error } = await createAdminClient().rpc("invitation_notice_register", {
    p_email_id: input.emailId,
    p_invitation_id: input.invitationId,
    p_to_user_id: input.recipient.userId,
    p_to_email_enc: encryptPii(email, {
      table: "email_messages",
      field: "to_email",
      tenantId: input.tenantId,
      rowId: input.emailId,
    }),
    p_to_email_hash: searchHash("email", input.tenantId, email),
  });
  if (error) throw new TeamGatewayError("notice_register", error.code);
  return (data as { registered?: boolean } | null)?.registered === true;
}
