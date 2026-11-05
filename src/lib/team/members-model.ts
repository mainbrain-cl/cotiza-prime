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

export type MemberControls = {
  canChangeRole: boolean;
  canRemove: boolean;
  /** Por qué no hay acciones (para decirlo en pantalla); `null` si las hay. */
  lockedReason: "organization_owner" | "yourself" | null;
};

/**
 * Qué acciones se ofrecen sobre un miembro. Nadie toca al Dueño ni a sí mismo. Es solo para la pantalla: la base
 * vuelve a exigir cada regla en cada función.
 */
export function memberControls(member: Pick<MemberRecord, "role" | "isSelf">): MemberControls {
  if (isOwnerRole(member.role))
    return { canChangeRole: false, canRemove: false, lockedReason: "organization_owner" };
  if (member.isSelf) return { canChangeRole: false, canRemove: false, lockedReason: "yourself" };
  return { canChangeRole: true, canRemove: true, lockedReason: null };
}

/** Los roles que se pueden dar, con la frase de qué puede hacer cada uno (salen de la matriz). */
export type RoleOption = { value: string; label: string; description: string };
export const ROLE_OPTIONS: readonly RoleOption[] = GRANTABLE_ROLES.map((role) => ({
  value: role,
  label: ROLE_LABELS[role],
  description: ROLE_DESCRIPTIONS[role],
}));

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
  /** La ficha del miembro. */
  href: string;
};

export function toMemberItem(member: MemberRecord, tenantId: string): MemberItem {
  const controls = memberControls(member);
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
export const MEMBER_INVALID_ROLE_MESSAGE = "Ese rol no se puede asignar. Elige uno de la lista.";
export const MEMBER_GENERIC_FAILURE =
  "No pudimos completar la acción. Intenta de nuevo en unos minutos; si sigue igual, avísanos.";
export const MEMBER_UNCHANGED_MESSAGE = "Esa persona ya tenía ese rol. No hubo cambios.";
export const MEMBER_ALREADY_REMOVED_MESSAGE = "Esa persona ya no estaba en tu equipo.";

export type MemberErrorKind =
  "forbidden" | "not_found" | "role_changed" | "target_owner" | "target_self" | "invalid" | "other";
export type MemberError = { kind: MemberErrorKind; message: string };

/**
 * Traduce los errores de `change_member_role` y `remove_member` a mensajes claros, sin detalle técnico.
 * Los códigos son los de la base: 42501 sin permiso, CP404 no existe en esta organización, CP409 el rol cambió,
 * CP422 dato inválido y CP423 el Dueño o uno mismo.
 */
export function mapMemberError(error: {
  code?: string | null;
  message?: string | null;
}): MemberError {
  const code = error.code ?? "";
  const reason = error.message ?? "";
  if (code === "42501") return { kind: "forbidden", message: NO_PERMISSION_MESSAGE };
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
