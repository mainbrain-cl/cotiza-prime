/**
 * Lo que la pantalla «Tu equipo» necesita saber de una invitación, sin base de datos ni servidor (H-008).
 * Los topes son los mismos de la migración `invitations` (`app.invitation_*`); una prueba de la base de
 * datos comprueba que no se separen.
 */

/** Cuántos días vale una invitación (también tras reenviarla). */
export const INVITATION_TTL_DAYS = 7;
export const INVITATION_MAX_PER_USER_HOUR = 20;
export const INVITATION_MAX_PER_TENANT_DAY = 50;
export const INVITATION_MAX_PENDING = 50;
export const INVITATION_MAX_RESENDS = 5;
export const INVITATION_RESEND_MIN_MINUTES = 10;
export const INVITATION_RETENTION_DAYS = 30;

const MS_PER_MINUTE = 60_000;
/** Un correo que lleva más de esto «enviándose» se da por no enviado (el servidor se cayó a medias). */
export const MAIL_PENDING_GRACE_MINUTES = 2;

export type InvitationMailStatus =
  "pending" | "sent" | "delivered" | "bounced" | "complained" | "failed";

export type InvitationTone = "neutral" | "accent" | "warning" | "danger" | "success";

export type InvitationDisplay = {
  /** Lo que dice la insignia. */
  label: string;
  tone: InvitationTone;
  /** El correo no salió o no llegó: la pantalla lo explica y ofrece reenviar. */
  needsAttention: boolean;
  expired: boolean;
};

export type InvitationDisplayInput = {
  expiresAt: string | Date;
  /** Estado del último correo de la invitación; `null` si no se encuentra. */
  mailStatus: InvitationMailStatus | null;
  mailCreatedAt: string | Date | null;
  now?: Date;
};

/** Cómo se ve una invitación PENDIENTE: vencida, sin enviar, rebotada o enviada. */
export function invitationDisplay(input: InvitationDisplayInput): InvitationDisplay {
  const now = input.now ?? new Date();
  const expired = new Date(input.expiresAt).getTime() <= now.getTime();
  if (expired) return { label: "Vencida", tone: "neutral", needsAttention: true, expired: true };
  switch (input.mailStatus) {
    case "bounced":
    case "complained":
      return {
        label: "El correo rebotó",
        tone: "danger",
        needsAttention: true,
        expired: false,
      };
    case "failed":
      return {
        label: "Pendiente, no enviada",
        tone: "warning",
        needsAttention: true,
        expired: false,
      };
    case "pending": {
      const created = input.mailCreatedAt ? new Date(input.mailCreatedAt).getTime() : 0;
      const stale = now.getTime() - created > MAIL_PENDING_GRACE_MINUTES * MS_PER_MINUTE;
      return stale
        ? { label: "Pendiente, no enviada", tone: "warning", needsAttention: true, expired: false }
        : { label: "Enviando…", tone: "neutral", needsAttention: false, expired: false };
    }
    case "sent":
    case "delivered":
      return { label: "Enviada", tone: "accent", needsAttention: false, expired: false };
    default:
      // Sin registro del correo no se puede afirmar que salió.
      return {
        label: "Pendiente, no enviada",
        tone: "warning",
        needsAttention: true,
        expired: false,
      };
  }
}

/** ¿Quedan reenvíos? `sendCount` cuenta el envío original más los reenvíos. */
export function resendsLeft(sendCount: number): number {
  return Math.max(0, INVITATION_MAX_RESENDS - (sendCount - 1));
}

/** Cuándo se podrá reenviar de nuevo (o `null` si ya se puede, o si no quedan reenvíos). */
export function nextResendAt(
  sendCount: number,
  lastSentAt: string | Date,
  now = new Date(),
): Date | null {
  if (resendsLeft(sendCount) === 0) return null;
  const at = new Date(
    new Date(lastSentAt).getTime() + INVITATION_RESEND_MIN_MINUTES * MS_PER_MINUTE,
  );
  return at.getTime() > now.getTime() ? at : null;
}
