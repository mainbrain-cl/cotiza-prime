import "server-only";
import { z } from "zod";
import { encryptPii } from "@/lib/crypto/pii";
import { searchHash } from "@/lib/crypto/search-hash";
import { normalizeEmail } from "@/lib/normalize/email";
import { createAdminClient } from "@/lib/supabase/admin-client";

/**
 * El PORTERO de las invitaciones (H-008). Es el único archivo de `src/lib/team/` que usa la llave maestra y
 * llama a CUATRO funciones de la base, todas solo del servidor:
 *  - `invitation_email_settle`: cierra el registro del correo de una invitación o de su aviso (enviado, con lo
 *    que informó el proveedor; o fallido, con un código sin datos personales);
 *  - `invitation_notices_pending`, `invitation_notice_recipients` e `invitation_notice_register`: el aviso al
 *    Dueño cuando alguien que no es el Dueño invita a un Administrador. La base lo deja anotado al invitar, decide
 *    a quién avisar y qué datos van; el aviso nunca lleva el correo del invitado. La tarea
 *    (`src/server/jobs/send-invitation-notices.ts`) lo envía y reintenta los fallidos.
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

const settleSchema = z.object({
  status: z.string(),
  /** Solo en el aviso al Dueño: el intento fallido fue el último permitido. */
  exhausted: z.boolean().optional(),
});

/**
 * Cierra el correo de una invitación o de su aviso: enviado (con lo que informó el proveedor) o fallido (solo un
 * código). `exhausted` es verdadero cuando un aviso al Dueño agotó sus intentos.
 */
export async function settleInvitationEmail(input: {
  emailId: string;
  sent?: { provider: string; providerMessageId: string };
  errorCode?: string;
}): Promise<{ exhausted: boolean }> {
  const { data, error } = await createAdminClient().rpc("invitation_email_settle", {
    p_email_id: input.emailId,
    p_provider: input.sent?.provider ?? null,
    p_provider_message_id: input.sent?.providerMessageId ?? null,
    p_error_code: input.sent ? null : (input.errorCode ?? "unknown"),
  });
  if (error) throw new TeamGatewayError("settle", error.code);
  const parsed = settleSchema.safeParse(data);
  return { exhausted: parsed.success && parsed.data.exhausted === true };
}

const pendingSchema = z.object({
  invitation_ids: z.array(z.uuid()).max(100),
  exhausted: z.number().int().min(0),
});

/**
 * RESERVA los avisos al Dueño que hay que atender ahora (pendientes, o fallidos que ya toca reintentar): reservar
 * gasta un intento en la base (con `skip locked`, dos tareas a la vez no toman el mismo aviso) y devuelve solo
 * identificadores de invitaciones, más cuántos acaban de agotar sus intentos. Con `invitationId` reserva solo ese
 * aviso (el intento inmediato después de invitar).
 */
export async function reserveInvitationNotices(
  limit: number,
  invitationId: string | null = null,
): Promise<{ invitationIds: string[]; exhausted: number }> {
  const { data, error } = await createAdminClient().rpc("invitation_notices_pending", {
    p_limit: limit,
    p_invitation_id: invitationId,
  });
  if (error) throw new TeamGatewayError("notices_pending", error.code);
  const parsed = pendingSchema.safeParse(data);
  if (!parsed.success) throw new TeamGatewayError("notices_pending", "shape");
  return { invitationIds: parsed.data.invitation_ids, exhausted: parsed.data.exhausted };
}

const recipientsSchema = z.object({
  tenant_id: z.uuid().optional(),
  tenant_name: z.string().optional(),
  inviter_name: z.string().nullable().optional(),
  role: z.string().optional(),
  invited_at: z.string().optional(),
  invitation_status: z.enum(["pending", "accepted"]).optional(),
  recipients: z.array(z.object({ user_id: z.uuid(), email: z.string().min(3).max(254) })).max(10),
  /** La base dio el aviso por agotado sin intentarlo: `no_recipient` (no hay un Dueño activo con correo). */
  exhausted: z.string().optional(),
});

export type InvitationNoticeInfo = {
  tenantId: string;
  tenantName: string;
  inviterName: string | null;
  role: string;
  invitedAt: string;
  /** Cómo está la invitación al enviar el aviso: pendiente (o vencida) o ya aceptada. */
  invitationStatus: "pending" | "accepted";
  recipients: { userId: string; email: string }[];
};

export type InvitationNoticeRead = {
  /** Los datos del aviso y a quién va; `null` si no hay un intento reservado que enviar. */
  notice: InvitationNoticeInfo | null;
  /** El aviso se dio por agotado sin poder enviarse (hoy solo `no_recipient`): la aplicación lo deja en el log. */
  exhaustedReason: string | null;
};

/**
 * A quién avisar de una invitación con un intento reservado y con qué datos, ya filtrados por la base. Sin
 * reserva, `notice` es `null`. La base no entrega el correo del invitado.
 */
export async function readInvitationNotice(invitationId: string): Promise<InvitationNoticeRead> {
  const { data, error } = await createAdminClient().rpc("invitation_notice_recipients", {
    p_invitation_id: invitationId,
  });
  if (error) throw new TeamGatewayError("notice_recipients", error.code);
  const parsed = recipientsSchema.safeParse(data);
  if (!parsed.success) throw new TeamGatewayError("notice_recipients", "shape");
  const body = parsed.data;
  const exhaustedReason = body.exhausted ?? null;
  if (body.recipients.length === 0) return { notice: null, exhaustedReason };
  if (!body.tenant_id || !body.tenant_name || !body.role || !body.invited_at) {
    throw new TeamGatewayError("notice_recipients", "shape");
  }
  return {
    exhaustedReason: null,
    notice: {
      tenantId: body.tenant_id,
      tenantName: body.tenant_name,
      inviterName: body.inviter_name ?? null,
      role: body.role,
      invitedAt: body.invited_at,
      invitationStatus: body.invitation_status ?? "pending",
      recipients: body.recipients.map((r) => ({ userId: r.user_id, email: r.email })),
    },
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
