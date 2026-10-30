import "server-only";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import {
  invitationDisplay,
  type InvitationDisplay,
  type InvitationMailStatus,
} from "./invitations-model";
import { readInvitationEmail } from "./record";

/** Invitaciones que se muestran de una vez: el tope de pendientes es 50, así que es un margen amplio. */
const LIST_LIMIT = 200;

export type InvitationRow = {
  id: string;
  /** `null` si el correo no se pudo descifrar (la fila se muestra igual, sin tumbar la lista). */
  email: string | null;
  role: string;
  expiresAt: string;
  createdAt: string;
  lastSentAt: string;
  sendCount: number;
  invitedByName: string | null;
  display: InvitationDisplay;
};

export type InvitationList = { ok: true; rows: InvitationRow[] } | { ok: false };

const MAIL_STATUSES: readonly string[] = [
  "pending",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
];
const asMailStatus = (value: unknown): InvitationMailStatus | null =>
  typeof value === "string" && MAIL_STATUSES.includes(value)
    ? (value as InvitationMailStatus)
    : null;

type StoredInvitation = {
  id: string;
  email_enc: string | null;
  role: string;
  expires_at: string;
  created_at: string;
  last_sent_at: string;
  send_count: number;
  invited_by: string;
};

/**
 * Las invitaciones PENDIENTES de la organización activa (vigentes y vencidas), la más nueva primero. Solo las
 * ve quien maneja el equipo: la base lo exige (política `invitations_select`) y la pantalla lo comprueba antes
 * de llamar aquí. El correo se descifra solo para mostrarlo; nada de esto se escribe en un log.
 */
export async function loadInvitations(active: ActiveTenant): Promise<InvitationList> {
  const { data, error } = await active.supabase
    .from("invitations")
    .select("id, email_enc, role, expires_at, created_at, last_sent_at, send_count, invited_by")
    .eq("tenant_id", active.tenantId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error || !data) {
    await serverLog("error", "invitations_list_failed", { code: error?.code });
    return { ok: false };
  }
  const invitations = data as StoredInvitation[];
  if (invitations.length === 0) return { ok: true, rows: [] };

  // El último correo de cada invitación (para saber si salió, si rebotó o si falló).
  const mailByInvitation = new Map<
    string,
    { status: InvitationMailStatus | null; createdAt: string }
  >();
  const { data: mails, error: mailError } = await active.supabase
    .from("email_messages")
    .select("invitation_id, status, created_at")
    .eq("tenant_id", active.tenantId)
    .eq("kind", "invitation")
    .in(
      "invitation_id",
      invitations.map((invitation) => invitation.id),
    )
    .order("created_at", { ascending: false });
  if (mailError)
    await serverLog("warn", "invitations_mail_status_failed", { code: mailError.code });
  for (const mail of (mails ?? []) as {
    invitation_id: string;
    status: string;
    created_at: string;
  }[]) {
    if (!mailByInvitation.has(mail.invitation_id)) {
      mailByInvitation.set(mail.invitation_id, {
        status: asMailStatus(mail.status),
        createdAt: mail.created_at,
      });
    }
  }

  // Quién invitó: el nombre del perfil de cada miembro de la organización.
  const names = new Map<string, string>();
  const inviterIds = [...new Set(invitations.map((invitation) => invitation.invited_by))];
  const { data: profiles } = await active.supabase
    .from("profiles")
    .select("user_id, full_name")
    .in("user_id", inviterIds);
  for (const profile of (profiles ?? []) as { user_id: string; full_name: string }[]) {
    names.set(profile.user_id, profile.full_name);
  }

  const now = new Date();
  return {
    ok: true,
    rows: invitations.map((invitation) => {
      const mail = mailByInvitation.get(invitation.id);
      return {
        id: invitation.id,
        email: readInvitationEmail(active.tenantId, invitation.id, invitation.email_enc),
        role: invitation.role,
        expiresAt: invitation.expires_at,
        createdAt: invitation.created_at,
        lastSentAt: invitation.last_sent_at,
        sendCount: invitation.send_count,
        invitedByName: names.get(invitation.invited_by) ?? null,
        display: invitationDisplay({
          expiresAt: invitation.expires_at,
          mailStatus: mail?.status ?? null,
          mailCreatedAt: mail?.createdAt ?? null,
          now,
        }),
      };
    }),
  };
}
