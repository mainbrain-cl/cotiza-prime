import "server-only";
import { deliverPendingInvitationNotices, type NoticeJobResult } from "@/lib/team/delivery";

/**
 * Tarea del aviso al Dueño (H-008, decisión de José: el aviso es robusto, no de mejor esfuerzo). EN PRODUCCIÓN eso
 * vale cuando `CRON_SECRET` esté definido y el programador la llame; ver más abajo.
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
 * Quién la llama: en producción, el programador de tareas de Vercel por la ruta
 * `GET /api/v1/jobs/invitation-notices` (protegida con `CRON_SECRET`; decisión #17). Falta configurar el
 * secreto en el proyecto de Vercel y probar que corre. El script `scripts/send-invitation-notices.ts` es SOLO
 * para uso local o manual (usa `tsx` y `.env.local`). Es seguro llamarla dos veces a la vez: la base reserva
 * cada aviso con `for update skip locked` y gasta el intento al reservarlo.
 */
export async function runSendInvitationNotices(): Promise<NoticeJobResult> {
  return deliverPendingInvitationNotices();
}

/**
 * Cuántos avisos atiende cada llamada del programador de tareas. Chico a propósito: cada envío puede tardar
 * hasta 20 s (`SEND_DEADLINE_MS`) y la ruta tiene 60 s (`maxDuration`). Lo que no alcance queda para la
 * corrida siguiente (la base solo reserva `limit` avisos por vez; no hace falta tocarla).
 */
export const SCHEDULED_NOTICE_BATCH_SIZE = 2;

/** La tarea tal como la corre la ruta `/api/v1/jobs/invitation-notices`: un lote chico que cabe en 60 s. */
export async function runScheduledInvitationNotices(): Promise<NoticeJobResult> {
  return deliverPendingInvitationNotices(SCHEDULED_NOTICE_BATCH_SIZE);
}
