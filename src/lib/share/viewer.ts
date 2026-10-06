import "server-only";
import { getOptionalUser } from "@/lib/auth/session";
import { listMemberships } from "@/lib/tenant/active-tenant";

/**
 * ¿Quien abre el enlace es miembro de la organización dueña de la cotización? Si tiene sesión y
 * pertenece a esa organización, su apertura no cuenta (es alguien del equipo revisando). Quien no
 * tiene sesión, o la tiene pero es de otra organización, se trata como cliente.
 */
export async function isViewerMemberOf(tenantId: string): Promise<boolean> {
  const user = await getOptionalUser();
  if (!user) return false;
  const memberships = await listMemberships(user.id);
  return memberships.some((membership) => membership.tenantId === tenantId);
}
