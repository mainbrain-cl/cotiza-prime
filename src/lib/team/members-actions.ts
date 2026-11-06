"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { MEMBER_NOT_FOUND_MESSAGE, changeRoleSchema, removeMemberSchema } from "./members-model";
import { changeMemberRole, removeMember } from "./members-service";
import type { MemberActionResult } from "./members-service";

/**
 * Acciones de la lista del equipo (H-010). Cada una resuelve la organización activa, exige el permiso de equipo
 * con la matriz ANTES de tocar la base (si no lo tiene, la base ni se consulta) y recién entonces valida y
 * ejecuta. La base vuelve a exigir el permiso y todas las reglas (el Dueño, uno mismo, el rol esperado) en cada
 * función. El resultado es un valor, nunca una excepción: así un fallo no pierde lo que la persona estaba haciendo.
 */

function refresh(tenantId: string) {
  // La lista y la ficha de cada miembro (`equipo/[memberId]`).
  revalidatePath(tenantPath(tenantId, "equipo"), "layout");
}

const invalidInput = (message?: string): MemberActionResult => ({
  status: "error",
  kind: "invalid",
  message: message ?? MEMBER_NOT_FOUND_MESSAGE,
});

/** Cambia el rol de un miembro. `expectedRole` es el rol que la persona vio: si ya es otro, no se cambia nada. */
export async function changeMemberRoleAction(
  tenantId: string,
  memberId: string,
  newRole: string,
  expectedRole: string,
): Promise<MemberActionResult> {
  const active = await requireActiveTenant(tenantId);
  const denied = requirePermission(active, "team.manage");
  if (denied) return { status: "error", kind: "forbidden", message: denied };

  const parsed = changeRoleSchema.safeParse({ memberId, newRole, expectedRole });
  if (!parsed.success) return invalidInput(parsed.error.issues[0]?.message);
  const result = await changeMemberRole(active, parsed.data);
  // Solo si funcionó: si falló (por ejemplo «el rol cambió»), la pantalla no se rehace para no taparle el aviso.
  if (result.status === "ok") refresh(active.tenantId);
  return result;
}

/**
 * Quita a un miembro del equipo: pierde el acceso en su siguiente clic. Lo que hizo se conserva. Esta acción no
 * rehace ninguna pantalla: lo hace el navegador al terminar (lista: se refresca; ficha: se va a la lista).
 */
export async function removeMemberAction(
  tenantId: string,
  memberId: string,
  expectedRole: string,
): Promise<MemberActionResult> {
  const active = await requireActiveTenant(tenantId);
  const denied = requirePermission(active, "team.manage");
  if (denied) return { status: "error", kind: "forbidden", message: denied };

  const parsed = removeMemberSchema.safeParse({ memberId, expectedRole });
  if (!parsed.success) return invalidInput(parsed.error.issues[0]?.message);
  // No se rehace la pantalla aquí: si se quita desde la ficha, rehacerla daría «No encontrado» (la persona ya no está)
  // antes de que el navegador vaya a la lista. Quien llama navega o refresca después (`MemberActions`).
  return removeMember(active, parsed.data);
}
