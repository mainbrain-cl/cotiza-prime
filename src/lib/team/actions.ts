"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/lib/auth/form-state";
import { fieldErrorsOf } from "@/lib/auth/schemas";
import { requirePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid, tenantPath } from "@/lib/tenant/constants";
import { INVITATION_NOT_FOUND } from "./errors";
import { inviteSchema } from "./schemas";
import { createInvitation, resendInvitation, revokeInvitation } from "./service";
import type { TeamActionResult } from "./service";

/**
 * Acciones de «Tu equipo» (H-008). Cada una resuelve la organización activa, exige el permiso de equipo con
 * la matriz ANTES de tocar la base (si no lo tiene, la base ni se consulta) y recién entonces valida y
 * ejecuta. La base vuelve a exigir el permiso en cada función (42501). Nada de lo que escribe la persona
 * (correo, nombre) llega a un log.
 */

export type InviteFormState = FormState & {
  /** Para «ya hay una invitación pendiente»: cuál es. */
  invitationId?: string;
};

function readText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function refresh(tenantId: string) {
  revalidatePath(tenantPath(tenantId, "equipo"));
}

/** Invita a una persona por correo con un rol. Crea la invitación y envía el correo. */
export async function inviteMemberAction(
  tenantId: string,
  _previous: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const active = await requireActiveTenant(tenantId);
  const values = { email: readText(formData, "email"), role: readText(formData, "role") };
  const denied = requirePermission(active, "team.manage");
  if (denied) return { status: "error", message: denied, values };

  const parsed = inviteSchema.safeParse(values);
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values };
  }
  const result = await createInvitation(active, parsed.data);
  if (result.status === "ok") {
    refresh(active.tenantId);
    // Si el correo no salió, la invitación existe igual: se avisa sin vaciar el formulario.
    return result.delivered
      ? { status: "sent", message: result.message }
      : { status: "error", message: result.message, values: { email: "", role: values.role } };
  }
  return {
    status: "error",
    message: result.message,
    values,
    ...(result.invitationId ? { invitationId: result.invitationId } : {}),
  };
}

/** Reenvía una invitación pendiente con un código nuevo (el enlace anterior deja de servir). */
export async function resendInvitationAction(
  tenantId: string,
  invitationId: string,
): Promise<TeamActionResult> {
  const active = await requireActiveTenant(tenantId);
  const denied = requirePermission(active, "team.manage");
  if (denied) return { status: "error", kind: "forbidden", message: denied };
  if (!isUuid(invitationId)) {
    return { status: "error", kind: "not_found", message: INVITATION_NOT_FOUND };
  }
  const result = await resendInvitation(active, invitationId);
  refresh(active.tenantId);
  return result;
}

/** Cancela una invitación pendiente: su enlace deja de servir al instante. */
export async function revokeInvitationAction(
  tenantId: string,
  invitationId: string,
): Promise<TeamActionResult> {
  const active = await requireActiveTenant(tenantId);
  const denied = requirePermission(active, "team.manage");
  if (denied) return { status: "error", kind: "forbidden", message: denied };
  if (!isUuid(invitationId)) {
    return { status: "error", kind: "not_found", message: INVITATION_NOT_FOUND };
  }
  const result = await revokeInvitation(active, invitationId);
  refresh(active.tenantId);
  return result;
}
