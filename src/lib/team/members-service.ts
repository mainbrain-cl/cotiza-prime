import "server-only";
import { z } from "zod";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { roleLabel } from "@/lib/permissions/matrix";
import {
  MEMBER_ALREADY_REMOVED_MESSAGE,
  MEMBER_GENERIC_FAILURE,
  MEMBER_UNCHANGED_MESSAGE,
  mapMemberError,
  type ChangeRoleInput,
  type MemberErrorKind,
  type RemoveMemberInput,
} from "./members-model";

/**
 * El corazón de H-010: cambiar el rol de un miembro y quitarlo. Corre con el pase de la persona (nunca con la
 * llave maestra); la base vuelve a revisar el permiso y todas las reglas en cada función. Quien llama
 * (`members-actions.ts`) ya comprobó que es miembro y que su rol alcanza ANTES de llegar aquí.
 *
 * Ningún nombre ni correo llega a un log: solo códigos.
 */

export type MemberActionResult =
  { status: "ok"; message: string } | { status: "error"; kind: MemberErrorKind; message: string };

const changedSchema = z.object({
  result: z.enum(["changed", "unchanged"]),
  role: z.string().optional(),
  cancelled_invitations: z.number().int().optional(),
});
const removedSchema = z.object({
  result: z.enum(["removed", "already_removed"]),
  cancelled_invitations: z.number().int().optional(),
  assigned_requests: z.number().int().optional(),
});

function failure(error: { code?: string | null; message?: string | null }, logName: string) {
  const mapped = mapMemberError(error);
  if (mapped.kind === "other") {
    // Solo el código: nunca el mensaje de la base ni datos de nadie.
    void serverLog("error", logName, { code: error.code ?? "unknown" });
  }
  return { status: "error", kind: mapped.kind, message: mapped.message } as const;
}

function shapeFailure(logName: string): MemberActionResult {
  void serverLog("error", logName, { code: "shape" });
  return { status: "error", kind: "other", message: MEMBER_GENERIC_FAILURE };
}

function invitationsNote(count: number | undefined): string {
  if (!count) return "";
  return count === 1
    ? " Se canceló 1 invitación que esa persona había enviado."
    : ` Se cancelaron ${count} invitaciones que esa persona había enviado.`;
}

/** Las solicitudes que quedaron asignadas a quien se fue: no se reasignan solas. */
function assignedNote(count: number | undefined): string {
  if (!count) return "";
  return count === 1
    ? " Tenía 1 solicitud asignada: queda esperando que la reasignes."
    : ` Tenía ${count} solicitudes asignadas: quedan esperando que las reasignes.`;
}

export async function changeMemberRole(
  active: ActiveTenant,
  input: ChangeRoleInput,
): Promise<MemberActionResult> {
  const { data, error } = await active.supabase.rpc("change_member_role", {
    p_member_id: input.memberId,
    p_new_role: input.newRole,
    p_expected_role: input.expectedRole,
  });
  if (error) return failure(error, "member_role_change_failed");
  const parsed = changedSchema.safeParse(data);
  if (!parsed.success) return shapeFailure("member_role_change_failed");
  if (parsed.data.result === "unchanged") {
    return { status: "ok", message: MEMBER_UNCHANGED_MESSAGE };
  }
  return {
    status: "ok",
    message: `El rol ahora es ${roleLabel(input.newRole)}. Se aplica en su siguiente clic.${invitationsNote(parsed.data.cancelled_invitations)}`,
  };
}

export async function removeMember(
  active: ActiveTenant,
  input: RemoveMemberInput,
): Promise<MemberActionResult> {
  const { data, error } = await active.supabase.rpc("remove_member", {
    p_member_id: input.memberId,
    p_expected_role: input.expectedRole,
  });
  if (error) return failure(error, "member_remove_failed");
  const parsed = removedSchema.safeParse(data);
  if (!parsed.success) return shapeFailure("member_remove_failed");
  if (parsed.data.result === "already_removed") {
    return { status: "ok", message: MEMBER_ALREADY_REMOVED_MESSAGE };
  }
  return {
    status: "ok",
    message: `La persona salió del equipo. Pierde el acceso en su siguiente clic.${invitationsNote(parsed.data.cancelled_invitations)}${assignedNote(parsed.data.assigned_requests)}`,
  };
}
