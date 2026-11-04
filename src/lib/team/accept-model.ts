import { z } from "zod";
import { isMemberRole, type MemberRole } from "@/lib/permissions/matrix";
import { INVITATION_TOKEN_LENGTH, isWellFormedInvitationToken } from "./invitation-code";

/**
 * Aceptar una invitación (H-009), sin base de datos ni servidor: los resultados que devuelve la base, los
 * mensajes que ve la persona y la cookie que guarda el código mientras ingresa o se registra.
 *
 * Regla de oro de los mensajes: son IDÉNTICOS tenga o no cuenta ese correo en Cotiza Prime. Nunca dicen «ya
 * tienes cuenta, ingresa», y ninguno nombra a la organización salvo la vista previa de una invitación que SÍ
 * es para el correo de quien la mira.
 */

/** La cookie que lleva el código de la invitación entre la apertura del enlace y el clic en «Unirme». */
export const INVITATION_COOKIE_NAME = "cp_invitation";
/** Una hora: lo que tarda alguien en registrarse y verificar su correo; después hay que abrir el enlace otra vez. */
export const INVITATION_COOKIE_MAX_AGE_SECONDS = 60 * 60;

/** Dónde se acepta la invitación (dentro de la aplicación, fuera de `/o/`). */
export const INVITATION_ACCEPT_PATH = "/invitacion";

/** Avisos que puede traer `/invitacion?aviso=...` (la ruta del enlace los pone cuando no guardó el código). */
export const INVITATION_NOTICES = {
  malformed: "enlace-no-valido",
  tooMany: "muchos-intentos",
} as const;

/** Aviso de la dirección → cómo se le explica a la persona. */
export const INVITATION_NOTICE_MESSAGES: Readonly<Record<string, string>> = {
  [INVITATION_NOTICES.malformed]:
    "Este enlace de invitación no es válido. Revisa que lo hayas abierto completo desde el correo, o pide que te envíen otra invitación.",
  [INVITATION_NOTICES.tooMany]:
    "Se abrieron muchos enlaces de invitación en poco tiempo. Espera un minuto y vuelve a abrir el enlace del correo.",
};

/** ¿La cookie trae algo con la forma de un código? Todo lo demás se ignora (no se consulta la base). */
export const invitationCodeSchema = z.string().refine(isWellFormedInvitationToken, {
  error: `El código de la invitación tiene ${INVITATION_TOKEN_LENGTH} caracteres.`,
});

/** Los resultados posibles de las dos funciones de la base. */
export const INVITATION_RESULTS = [
  "ok",
  "accepted",
  "unverified",
  "rate_limited",
  "not_found",
  "wrong_email",
  "revoked",
  "inviter_inactive",
  "expired",
  "used",
  "archived",
] as const;
export type InvitationResult = (typeof INVITATION_RESULTS)[number];

/** Resultados que NO tienen arreglo: el código no sirve y hay que pedir otra invitación. */
export const DEAD_RESULTS: ReadonlySet<InvitationResult> = new Set([
  "not_found",
  "revoked",
  "inviter_inactive",
  "expired",
  "used",
  "archived",
]);

const uuid = z.uuid();

/** Lo que devuelve `invitation_preview`. */
export const previewResponseSchema = z.object({
  result: z.enum(INVITATION_RESULTS),
  tenant_id: uuid.optional(),
  /** Ya eres miembro activo: aceptar no cambia tu rol (`current_role`). */
  already_member: z.boolean().optional(),
  current_role: z.string().nullable().optional(),
  tenant_name: z.string().optional(),
  inviter_name: z.string().nullable().optional(),
  role: z.string().optional(),
  expires_at: z.string().optional(),
});

/** Lo que devuelve `accept_invitation`. */
export const acceptResponseSchema = z.object({
  result: z.enum(INVITATION_RESULTS),
  tenant_id: uuid.optional(),
  role: z.string().optional(),
  already_member: z.boolean().optional(),
  reactivated: z.boolean().optional(),
});

/** Mensaje de cada resultado que no es un éxito. Dicen qué pasó y a quién pedir otra; nunca de qué organización. */
export const RESULT_MESSAGES: Readonly<
  Record<Exclude<InvitationResult, "ok" | "accepted">, string>
> = {
  not_found:
    "Este enlace de invitación no es válido. Revisa que lo hayas abierto completo desde el correo, o pide a quien te invitó que te envíe otra.",
  revoked: "Esta invitación fue cancelada. Pide a quien te invitó que te envíe una nueva.",
  inviter_inactive:
    "Esta invitación ya no es válida: quien te invitó dejó de poder invitar. Pide a otra persona de la organización que te invite de nuevo.",
  expired: "Esta invitación venció. Pide a quien te invitó que te envíe una nueva.",
  used: "Esta invitación ya se usó. Si necesitas entrar, pide a quien te invitó que te envíe una nueva.",
  archived:
    "La organización a la que te invitaron ya no está activa. Consulta con quien te invitó.",
  wrong_email:
    "Esta invitación es para otro correo. Ingresa con el correo al que llegó la invitación.",
  unverified:
    "Primero verifica tu correo con el enlace que te enviamos y luego vuelve a abrir la invitación.",
  rate_limited: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
};

/** Cuando la petición ni siquiera llega al servidor (sin red): el problema no es nuestro y la invitación sigue guardada. */
export const INVITATION_OFFLINE_MESSAGE =
  "No pudimos comunicarnos con el servidor. Revisa tu conexión e inténtalo de nuevo; tu invitación sigue guardada.";

export const INVITATION_GENERIC_FAILURE =
  "No pudimos completar la acción. Intenta de nuevo en unos minutos; si sigue igual, pide que te envíen otra invitación.";

/** Cuando falta la cookie (se venció, o la persona verificó su correo en otro dispositivo). */
export const MISSING_CODE_MESSAGE =
  "No encontramos tu invitación en este navegador. Abre de nuevo el enlace del correo que te enviaron.";

/** El texto de ayuda para quien terminó de registrarse en otro dispositivo y llega a un inicio vacío. */
export const INVITED_HINT = "¿Te invitaron? Abre de nuevo el enlace del correo de la invitación.";

/** Mensaje de un resultado fallido. */
export function messageForResult(result: InvitationResult): string {
  if (result === "ok" || result === "accepted") return INVITATION_GENERIC_FAILURE;
  return RESULT_MESSAGES[result];
}

/** Rol de la invitación para mostrarlo; uno desconocido (no debería pasar) no se inventa. */
export function invitedRole(role: string | undefined): MemberRole | null {
  return isMemberRole(role) ? role : null;
}

/** «Ana te invitó a Negocio 1 como Comercial.» Sin nombre de quien invita, la frase sigue siendo clara. */
export function invitationSentence(input: {
  inviterName: string | null | undefined;
  organizationName: string;
  roleLabel: string;
}): string {
  const who = input.inviterName?.trim() ? input.inviterName.trim() : "Un miembro del equipo";
  return `${who} te invitó a ${input.organizationName} como ${input.roleLabel}.`;
}

/** Lo que devuelve «Unirme» a la pantalla. Vive aquí y no en el archivo de acciones: un archivo `"use server"` solo puede exportar funciones. */
export type AcceptState = {
  status: "idle" | "error";
  message?: string;
  /** El código ya no sirve para nada: la pantalla ofrece salir en vez de reintentar. */
  dead?: boolean;
};

export const INITIAL_ACCEPT_STATE: AcceptState = { status: "idle" };

/** Para quien ya es miembro: aceptar marca la invitación como usada, pero su rol no cambia. */
export function alreadyMemberSentence(input: {
  organizationName: string;
  roleLabel: string;
}): string {
  return `Ya eres parte de ${input.organizationName} como ${input.roleLabel}. Esta invitación no cambia tu rol.`;
}

/** Los resultados que se arreglan con volver a intentar (no hay que borrar el código). */
export const RETRY_RESULTS: ReadonlySet<InvitationResult> = new Set(["rate_limited", "unverified"]);
