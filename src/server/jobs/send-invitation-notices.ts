import "server-only";
import { deliverPendingInvitationNotices } from "@/lib/team/delivery";

/**
 * Tarea del aviso al Dueño (H-008, decisión de José: el aviso es robusto, no de mejor esfuerzo).
 *
 * Cuando alguien que no es el Dueño invita a un Administrador, la base deja el aviso anotado como pendiente en
 * la misma operación (`invitations.owner_notice_state`). Esta tarea envía los pendientes y REINTENTA los que
 * fallaron: como máximo `app.invitation_notice_max_attempts()` intentos, separados al menos
 * `app.invitation_notice_retry_minutes()` minutos (constantes de la base). Un aviso que agota sus intentos
 * queda en el log como `invitation_notice_exhausted` (solo un código, sin datos personales) y con
 * `owner_notice_state = 'exhausted'` en la base.
 *
 * Hay que programarla para que corra cada pocos minutos (por ejemplo, `npm run job:invitation-notices` desde un
 * cron del servidor). Nunca lanza.
 */
export async function runSendInvitationNotices(): Promise<{ attended: number; exhausted: number }> {
  return deliverPendingInvitationNotices();
}
