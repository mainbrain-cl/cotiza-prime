import "server-only";
import { deliverPendingInvitationNotices, type NoticeJobResult } from "@/lib/team/delivery";

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
 * Nunca lanza: `failed` dice que no pudo ni empezar.
 *
 * PENDIENTE (decisión propia, antes del piloto): cómo se programa en producción. El script
 * `scripts/send-invitation-notices.ts` es SOLO para uso local o manual (usa `tsx` y `.env.local`). En Vercel las
 * tareas programadas llaman a una dirección HTTP protegida por un secreto; esa ruta no existe, a propósito,
 * hasta decidirlo. Mientras tanto, en producción el aviso es de mejor esfuerzo: solo corre el intento inmediato.
 */
export async function runSendInvitationNotices(): Promise<NoticeJobResult> {
  return deliverPendingInvitationNotices();
}
