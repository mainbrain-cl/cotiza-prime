import { NO_PERMISSION_MESSAGE } from "@/lib/permissions/matrix";
import {
  INVITATION_MAX_PENDING,
  INVITATION_MAX_PER_TENANT_DAY,
  INVITATION_MAX_RESENDS,
  INVITATION_RESEND_MIN_MINUTES,
} from "./invitations-model";

/**
 * Traduce los errores de las funciones de invitaciones (H-008) a mensajes claros, sin detalle técnico.
 * Los códigos son los de la base: 42501 sin permiso, CP404 no existe en esta organización, CP422 dato
 * inválido, CP423 estado que no admite el cambio y CP429 tope alcanzado.
 */

export type TeamErrorKind = "forbidden" | "not_found" | "state" | "invalid" | "limit" | "other";
export type TeamError = { kind: TeamErrorKind; message: string };

export const TEAM_GENERIC_FAILURE =
  "No pudimos completar la acción. Intenta de nuevo en unos minutos; si sigue igual, avísanos.";
export const INVITATION_NOT_FOUND = "No encontramos esta invitación. Puede que ya no exista.";

const LIMIT_MESSAGES: Record<string, string> = {
  limit_user_hour:
    "Enviaste muchas invitaciones en la última hora. Espera un rato e inténtalo de nuevo.",
  limit_tenant_day: `Tu organización llegó al máximo de ${INVITATION_MAX_PER_TENANT_DAY} invitaciones por día. Inténtalo mañana.`,
  limit_pending: `Tienes ${INVITATION_MAX_PENDING} invitaciones pendientes. Cancela alguna o espera a que venzan para invitar a más personas.`,
  limit_resends: `Esta invitación ya se reenvió ${INVITATION_MAX_RESENDS} veces. Cancélala y crea una nueva.`,
  resend_too_soon: `Esta invitación se envió hace poco. Espera ${INVITATION_RESEND_MIN_MINUTES} minutos para reenviarla.`,
};

export function mapTeamError(error: { code?: string | null; message?: string | null }): TeamError {
  const code = error.code ?? "";
  if (code === "42501") return { kind: "forbidden", message: NO_PERMISSION_MESSAGE };
  if (code === "CP404") return { kind: "not_found", message: INVITATION_NOT_FOUND };
  if (code === "CP423") {
    return {
      kind: "state",
      message: "Esta invitación ya no está pendiente. Recarga la página para ver cómo quedó.",
    };
  }
  if (code === "CP429") {
    return {
      kind: "limit",
      message:
        LIMIT_MESSAGES[error.message ?? ""] ??
        "Llegaste a un límite. Espera un momento e inténtalo de nuevo.",
    };
  }
  if (code === "CP422") {
    return {
      kind: "invalid",
      message: "Hay algo en lo que enviaste que no pudimos aceptar. Revisa el correo y el rol.",
    };
  }
  return { kind: "other", message: TEAM_GENERIC_FAILURE };
}
