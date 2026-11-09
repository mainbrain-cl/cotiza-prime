import "server-only";
import { z } from "zod";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { deliverInvitationEmail } from "./delivery";
import {
  INVITATION_NOT_FOUND,
  TEAM_GENERIC_FAILURE,
  mapTeamError,
  type TeamErrorKind,
} from "./errors";
import { buildNewInvitation, buildResend, readInvitationEmail } from "./record";
import type { InviteInput } from "./schemas";

/**
 * El corazón de H-008: invitar, reenviar y cancelar. Corre con el pase de la persona (nunca con la llave
 * maestra); la base vuelve a revisar el permiso en cada función. Quien llama (`actions.ts`) ya comprobó que
 * es miembro y que su rol alcanza ANTES de llegar aquí.
 *
 * Reglas:
 *  - El resultado y los mensajes son IDÉNTICOS tenga o no cuenta ese correo en Cotiza Prime: la única
 *    comparación con personas existentes es contra los miembros de ESTA organización (dentro de la base).
 *  - El correo, el nombre y el código del enlace no se escriben jamás en un log: solo códigos.
 */

export type TeamActionResult =
  | {
      status: "ok";
      message: string;
      delivered?: boolean;
      /** La invitación para la que hay que intentar el aviso al Dueño (la acción lo hace sin hacer esperar). */
      notifyOwnerOf?: string;
    }
  | {
      status: "error";
      kind: TeamErrorKind | "exists" | "member";
      message: string;
      /** Para «ya hay una invitación pendiente»: cuál es, para resaltarla. */
      invitationId?: string;
    };

export const ALREADY_MEMBER_MESSAGE = "Esa persona ya es parte de tu equipo.";
export const ALREADY_PENDING_MESSAGE =
  "Ya hay una invitación pendiente para ese correo. Puedes reenviarla desde la lista.";
export const MAIL_NOT_SENT_MESSAGE =
  "Creamos la invitación, pero no pudimos enviar el correo. Aparece en la lista como «Pendiente, no enviada»: reenvíala desde ahí.";
export const UNREADABLE_EMAIL_MESSAGE =
  "No pudimos leer el correo de esta invitación. Cancélala y crea una nueva.";

const createdSchema = z.object({
  result: z.enum(["created", "already_member", "already_pending"]),
  invitation_id: z.uuid().optional(),
  email_message_id: z.uuid().optional(),
  expires_at: z.string().optional(),
  /** La base dice si el Dueño debe enterarse (alguien que no es el Dueño invitó a un Administrador). */
  notify_owner: z.boolean().optional(),
});
const resentSchema = z.object({
  result: z.literal("resent"),
  email_message_id: z.uuid(),
  expires_at: z.string(),
});
const revokedSchema = z.object({ result: z.enum(["revoked", "already_revoked"]) });

function failure(error: { code?: string | null; message?: string | null }, logName: string) {
  const mapped = mapTeamError(error);
  if (mapped.kind === "other") {
    // Solo el código: nunca el mensaje de la base ni datos de nadie.
    void serverLog("error", logName, { code: error.code ?? "unknown" });
  } else if (mapped.kind === "owner_only") {
    // Alguien que no es el Dueño intentó algo solo del Dueño: se anota solo el código (aviso, no error), nunca
    // correos, nombres ni identificadores de personas. Cuenta solo los rechazos que llegan desde la pantalla: quien llama
    // la base directo no pasa por aquí.
    void serverLog("warn", logName, { code: "owner_only" });
  }
  return { status: "error", kind: mapped.kind, message: mapped.message } as const;
}

/** Nombre de quien invita, para el correo (puede venir vacío: el correo igual sale). */
async function inviterName(active: ActiveTenant): Promise<string> {
  const { data } = await active.supabase
    .from("profiles")
    .select("full_name")
    .eq("user_id", active.userId)
    .maybeSingle();
  // Si falta o es solo espacios, el armador del correo usa el texto de respaldo (una sola constante).
  return typeof data?.full_name === "string" ? data.full_name : "";
}

export async function createInvitation(
  active: ActiveTenant,
  input: InviteInput,
): Promise<TeamActionResult> {
  const invitation = buildNewInvitation(active.tenantId, input.email, input.role);
  const { data, error } = await active.supabase.rpc("create_invitation", invitation.params);
  if (error) return failure(error, "invitation_create_failed");
  const parsed = createdSchema.safeParse(data);
  if (!parsed.success) {
    void serverLog("error", "invitation_create_failed", { code: "shape" });
    return { status: "error", kind: "other", message: TEAM_GENERIC_FAILURE };
  }
  const body = parsed.data;
  if (body.result === "already_member") {
    return { status: "error", kind: "member", message: ALREADY_MEMBER_MESSAGE };
  }
  if (body.result === "already_pending") {
    return {
      status: "error",
      kind: "exists",
      message: ALREADY_PENDING_MESSAGE,
      invitationId: body.invitation_id,
    };
  }
  if (!body.expires_at) {
    void serverLog("error", "invitation_create_failed", { code: "shape" });
    return { status: "error", kind: "other", message: TEAM_GENERIC_FAILURE };
  }
  const delivered = await deliverInvitationEmail({
    emailId: invitation.emailMessageId,
    recipientAddress: invitation.email,
    inviterName: await inviterName(active),
    organizationName: active.tenantName,
    role: input.role,
    expiresAt: body.expires_at,
    token: invitation.token,
  });
  // El aviso al Dueño ya quedó anotado en la base; la acción intenta enviarlo después de responder.
  const notifyOwnerOf = body.notify_owner === true ? invitation.invitationId : undefined;
  return delivered
    ? {
        status: "ok",
        delivered: true,
        notifyOwnerOf,
        message: `Enviamos la invitación a ${invitation.email}.`,
      }
    : { status: "ok", delivered: false, notifyOwnerOf, message: MAIL_NOT_SENT_MESSAGE };
}

export async function resendInvitation(
  active: ActiveTenant,
  invitationId: string,
): Promise<TeamActionResult> {
  const { data: row, error: readError } = await active.supabase
    .from("invitations")
    .select("id, email_enc, role, status")
    .eq("tenant_id", active.tenantId)
    .eq("id", invitationId)
    .maybeSingle();
  if (readError) return failure(readError, "invitation_resend_read_failed");
  if (!row) return { status: "error", kind: "not_found", message: INVITATION_NOT_FOUND };
  if (row.status !== "pending") return failure({ code: "CP423" }, "invitation_resend_failed");
  const email = readInvitationEmail(active.tenantId, invitationId, row.email_enc);
  if (!email) {
    void serverLog("error", "invitation_resend_failed", { code: "unreadable_email" });
    return { status: "error", kind: "other", message: UNREADABLE_EMAIL_MESSAGE };
  }

  const resend = buildResend(active.tenantId, invitationId, email);
  const { data, error } = await active.supabase.rpc("resend_invitation", resend.params);
  if (error) return failure(error, "invitation_resend_failed");
  const parsed = resentSchema.safeParse(data);
  if (!parsed.success) {
    void serverLog("error", "invitation_resend_failed", { code: "shape" });
    return { status: "error", kind: "other", message: TEAM_GENERIC_FAILURE };
  }
  const delivered = await deliverInvitationEmail({
    emailId: resend.emailMessageId,
    recipientAddress: email,
    inviterName: await inviterName(active),
    organizationName: active.tenantName,
    role: row.role,
    expiresAt: parsed.data.expires_at,
    token: resend.token,
  });
  return delivered
    ? { status: "ok", delivered: true, message: `Reenviamos la invitación a ${email}.` }
    : {
        status: "ok",
        delivered: false,
        message:
          "Actualizamos la invitación, pero no pudimos enviar el correo. Intenta reenviarla de nuevo en unos minutos.",
      };
}

export async function revokeInvitation(
  active: ActiveTenant,
  invitationId: string,
): Promise<TeamActionResult> {
  const { data, error } = await active.supabase.rpc("revoke_invitation", {
    p_invitation_id: invitationId,
  });
  if (error) return failure(error, "invitation_revoke_failed");
  const parsed = revokedSchema.safeParse(data);
  if (!parsed.success) {
    void serverLog("error", "invitation_revoke_failed", { code: "shape" });
    return { status: "error", kind: "other", message: TEAM_GENERIC_FAILURE };
  }
  return {
    status: "ok",
    message: "Cancelamos la invitación. El enlace que se envió ya no sirve.",
  };
}
