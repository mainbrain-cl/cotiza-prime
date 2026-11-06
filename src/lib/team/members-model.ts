import { z } from "zod";
import { formatDate } from "@/lib/format-date";
import {
  can,
  GRANTABLE_ROLES,
  isGrantableRole,
  isMemberRole,
  NO_PERMISSION_MESSAGE,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type MemberRole,
} from "@/lib/permissions/matrix";
import { tenantPath } from "@/lib/tenant/constants";

/**
 * Lo que la lista del equipo y la ficha de un miembro necesitan saber, sin base de datos ni servidor (H-010).
 * Los nombres de los roles viven solo en `src/lib/permissions/`; aquí se decide con la matriz.
 */

/** Un miembro activo, como lo entrega `list_members()`. */
export type MemberRecord = {
  memberId: string;
  userId: string;
  /** `null` si el perfil no tiene nombre. */
  name: string | null;
  email: string | null;
  role: MemberRole;
  joinedAt: string;
  /** Es la persona que está mirando la pantalla. */
  isSelf: boolean;
};

/** La forma que devuelve la base. Un rol desconocido hace fallar la lectura entera: mejor un error que un rol inventado. */
export const memberRecordSchema = z
  .object({
    member_id: z.uuid(),
    user_id: z.uuid(),
    full_name: z.string().nullable(),
    email: z.string().nullable(),
    role: z.string().refine(isMemberRole, "rol desconocido"),
    joined_at: z.string(),
    is_self: z.boolean(),
  })
  .transform((row): MemberRecord => ({
    memberId: row.member_id,
    userId: row.user_id,
    name: row.full_name,
    email: row.email,
    role: row.role as MemberRole,
    joinedAt: row.joined_at,
    isSelf: row.is_self,
  }));

export const memberListSchema = z.array(memberRecordSchema);

/** ¿Este rol es el del Dueño? Se decide con la matriz (el único que puede transferir la organización). */
export function isOwnerRole(role: string): boolean {
  return can(role, "tenant.transfer");
}

/** ¿Este rol maneja el equipo (invita, cambia roles, quita)? Hoy: Dueño y Administrador, según la matriz. */
export function managesTeam(role: string): boolean {
  return can(role, "team.manage");
}

/** El id del título «Miembros» de «Tu equipo»: ahí vuelve el foco cuando una fila desaparece (H-010). */
export const MEMBERS_HEADING_ID = "members-title";

export type MemberControls = {
  canChangeRole: boolean;
  canRemove: boolean;
  /** Por qué no hay acciones (para decirlo en pantalla); `null` si las hay. */
  lockedReason: "organization_owner" | "yourself" | "owner_only" | null;
};

/**
 * Qué acciones se ofrecen sobre un miembro a quien mira con `viewerRole`. Nadie toca al Dueño ni a sí mismo, y a
 * quien maneja el equipo (un Administrador) solo lo cambia o lo quita el Dueño. Es solo para la pantalla: la base
 * vuelve a exigir cada regla en cada función.
 */
export function memberControls(
  member: Pick<MemberRecord, "role" | "isSelf">,
  viewerRole: string,
): MemberControls {
  if (isOwnerRole(member.role))
    return { canChangeRole: false, canRemove: false, lockedReason: "organization_owner" };
  if (member.isSelf) return { canChangeRole: false, canRemove: false, lockedReason: "yourself" };
  if (managesTeam(member.role) && !isOwnerRole(viewerRole))
    return { canChangeRole: false, canRemove: false, lockedReason: "owner_only" };
  return { canChangeRole: true, canRemove: true, lockedReason: null };
}

/** Los roles que se pueden dar, con la frase de qué puede hacer cada uno (salen de la matriz). */
export type RoleOption = {
  value: string;
  label: string;
  description: string;
  /** El rol maneja el equipo: quien lo pierde ve canceladas sus invitaciones pendientes. */
  managesTeam: boolean;
};
export const ROLE_OPTIONS: readonly RoleOption[] = GRANTABLE_ROLES.map((role) => ({
  value: role,
  label: ROLE_LABELS[role],
  description: ROLE_DESCRIPTIONS[role],
  managesTeam: managesTeam(role),
}));

/**
 * Los roles que `viewerRole` puede dar, al CAMBIAR el rol de alguien y al INVITAR: el Dueño, todos; los demás, solo
 * los que no manejan el equipo (un Administrador no nombra ni invita Administradores). La base exige lo mismo en
 * `change_member_role`, `create_invitation` y `resend_invitation` (`owner_only`).
 */
export function roleOptionsFor(viewerRole: string): RoleOption[] {
  return ROLE_OPTIONS.filter((option) => isOwnerRole(viewerRole) || !option.managesTeam);
}

/** Lo que ve bajo los roles del formulario de invitar quien no es el Dueño (no se le ofrece «Administrador»). */
export const INVITE_OWNER_ONLY_NOTE = "Solo el Dueño puede invitar Administradores.";

/**
 * ¿Quien mira con `viewerRole` puede reenviar una invitación con el rol `invitationRole`? Si ese rol maneja el
 * equipo, solo el Dueño: reenviar vuelve a fijar el código y el correo al que queda atada la invitación, así que es casi lo
 * mismo que invitar. Cancelarla sí puede cualquiera que maneje el equipo. La base exige lo mismo (`owner_only`).
 */
export function canResendInvitation(invitationRole: string, viewerRole: string): boolean {
  return isOwnerRole(viewerRole) || !managesTeam(invitationRole);
}

/** Lo que ve quien no es el Dueño en una invitación a Administrador, en lugar del botón «Reenviar». */
export const INVITATION_RESEND_OWNER_ONLY_NOTE =
  "Solo el Dueño puede reenviar la invitación de un Administrador. Tú puedes cancelarla.";

/** Un miembro listo para mostrar en la lista y en su ficha: todo el texto ya viene armado desde el servidor. */
export type MemberItem = {
  memberId: string;
  /** Nombre; si falta, su correo; si tampoco, «esta persona». */
  displayName: string;
  email: string | null;
  /** El rol tal cual (para que la base compruebe que no cambió). */
  role: string;
  roleLabel: string;
  roleDescription: string;
  /** «Ingresó el dd-mm-aaaa». */
  joinedLabel: string;
  isSelf: boolean;
  isOwner: boolean;
  canChangeRole: boolean;
  canRemove: boolean;
  /** Por qué no hay acciones sobre esta persona; `null` si las hay. */
  lockedReason: MemberControls["lockedReason"];
  /** La ficha del miembro. */
  href: string;
};

/** Un miembro listo para la pantalla de quien mira con `viewerRole` (decide qué acciones se le ofrecen). */
export function toMemberItem(
  member: MemberRecord,
  tenantId: string,
  viewerRole: string,
): MemberItem {
  const controls = memberControls(member, viewerRole);
  return {
    memberId: member.memberId,
    displayName: member.name ?? member.email ?? "esta persona",
    email: member.email,
    role: member.role,
    roleLabel: ROLE_LABELS[member.role],
    roleDescription: ROLE_DESCRIPTIONS[member.role],
    joinedLabel: `Ingresó el ${formatDate(member.joinedAt)}`,
    isSelf: member.isSelf,
    isOwner: controls.lockedReason === "organization_owner",
    canChangeRole: controls.canChangeRole,
    canRemove: controls.canRemove,
    lockedReason: controls.lockedReason,
    href: tenantPath(tenantId, `equipo/${member.memberId}`),
  };
}

/** Lo que llega al cambiar el rol: ids, el rol nuevo (nunca el Dueño) y el rol que la persona vio en pantalla. */
export const changeRoleSchema = z.object({
  memberId: z.uuid({ error: "Esta persona ya no está en tu equipo." }),
  newRole: z
    .string({ error: "Elige el rol." })
    .refine(isGrantableRole, "Elige uno de los roles de la lista."),
  expectedRole: z.string().refine(isMemberRole, "No pudimos leer el rol actual."),
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

export const removeMemberSchema = z.object({
  memberId: z.uuid({ error: "Esta persona ya no está en tu equipo." }),
  expectedRole: z.string().refine(isMemberRole, "No pudimos leer el rol actual."),
});
export type RemoveMemberInput = z.infer<typeof removeMemberSchema>;

// --- Mensajes ---------------------------------------------------------------------------------------------

export const MEMBER_NOT_FOUND_MESSAGE =
  "No encontramos a esta persona en tu equipo. Puede que ya no esté: recarga la página.";
export const MEMBER_ROLE_CHANGED_MESSAGE =
  "El rol cambió mientras lo editabas. Recarga la página para ver cómo quedó.";
export const MEMBER_OWNER_MESSAGE = "El Dueño no se puede cambiar ni quitar desde aquí.";
export const MEMBER_SELF_MESSAGE = "No puedes cambiar tu propio rol ni quitarte del equipo.";
/** Lo que ve un Administrador en la fila de otro Administrador. */
export const MEMBER_OWNER_ONLY_NOTE =
  "Solo el Dueño puede cambiar el rol de un Administrador o quitarlo del equipo.";
/** Si un Administrador intenta igual nombrar, bajar o quitar a un Administrador (la base lo rechaza). */
export const MEMBER_OWNER_ONLY_MESSAGE =
  "Solo el Dueño puede nombrar Administradores, cambiarles el rol o quitarlos del equipo.";
/** Se muestra ANTES de confirmar que alguien deja de manejar el equipo (`change_member_role` hace exactamente esto). */
export const MEMBER_DEMOTE_NOTE = "Las invitaciones pendientes que envió se cancelarán.";
export const MEMBER_RATE_LIMITED_MESSAGE =
  "Hiciste muchos cambios en tu equipo en la última hora (cambios de rol y personas quitadas). Espera un rato y vuelve a intentar.";
export const MEMBER_INVALID_ROLE_MESSAGE = "Ese rol no se puede asignar. Elige uno de la lista.";
export const MEMBER_GENERIC_FAILURE =
  "No pudimos completar la acción. Intenta de nuevo en unos minutos; si sigue igual, avísanos.";
export const MEMBER_UNCHANGED_MESSAGE = "Esa persona ya tenía ese rol. No hubo cambios.";
export const MEMBER_ALREADY_REMOVED_MESSAGE = "Esa persona ya no estaba en tu equipo.";

export type MemberErrorKind =
  | "forbidden"
  | "owner_only"
  | "not_found"
  | "role_changed"
  | "target_owner"
  | "target_self"
  | "invalid"
  | "rate_limited"
  | "other";
export type MemberError = { kind: MemberErrorKind; message: string };

/**
 * Traduce los errores de `change_member_role` y `remove_member` a mensajes claros, sin detalle técnico.
 * Los códigos son los de la base: 42501 sin permiso (con el motivo `owner_only`: solo el Dueño maneja a los
 * Administradores), CP404 no existe en esta organización, CP409 el rol cambió, CP422 dato inválido, CP423 el Dueño o
 * uno mismo y CP429 el tope de cambios de rol por hora.
 */
export function mapMemberError(error: {
  code?: string | null;
  message?: string | null;
}): MemberError {
  const code = error.code ?? "";
  const reason = error.message ?? "";
  if (code === "42501") {
    return reason === "owner_only"
      ? { kind: "owner_only", message: MEMBER_OWNER_ONLY_MESSAGE }
      : { kind: "forbidden", message: NO_PERMISSION_MESSAGE };
  }
  if (code === "CP429") return { kind: "rate_limited", message: MEMBER_RATE_LIMITED_MESSAGE };
  if (code === "CP404") return { kind: "not_found", message: MEMBER_NOT_FOUND_MESSAGE };
  if (code === "CP409") return { kind: "role_changed", message: MEMBER_ROLE_CHANGED_MESSAGE };
  if (code === "CP423") {
    return reason === "cannot_target_self"
      ? { kind: "target_self", message: MEMBER_SELF_MESSAGE }
      : { kind: "target_owner", message: MEMBER_OWNER_MESSAGE };
  }
  if (code === "CP422") {
    return reason === "invalid_role"
      ? { kind: "invalid", message: MEMBER_INVALID_ROLE_MESSAGE }
      : { kind: "invalid", message: MEMBER_GENERIC_FAILURE };
  }
  return { kind: "other", message: MEMBER_GENERIC_FAILURE };
}
