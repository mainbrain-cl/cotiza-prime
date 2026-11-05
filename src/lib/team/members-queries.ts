import "server-only";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { memberListSchema, type MemberRecord } from "./members-model";

/**
 * Los miembros activos de la organización activa, con su correo (H-010). La lista la entrega la función
 * `list_members()` de la base, que solo responde a quien maneja el equipo; la pantalla además comprueba el permiso
 * ANTES de llamar aquí. Nada de esto se escribe en un log (solo códigos).
 */

export type MemberList = { ok: true; members: MemberRecord[] } | { ok: false };

export async function loadMembers(active: ActiveTenant): Promise<MemberList> {
  const { data, error } = await active.supabase.rpc("list_members");
  if (error) {
    await serverLog("error", "members_list_failed", { code: error.code });
    return { ok: false };
  }
  const parsed = memberListSchema.safeParse(data);
  if (!parsed.success) {
    await serverLog("error", "members_list_failed", { code: "shape" });
    return { ok: false };
  }
  return { ok: true, members: parsed.data };
}

export type MemberLookup =
  { status: "ok"; member: MemberRecord } | { status: "not_found" } | { status: "error" };

/**
 * Un miembro activo de ESTA organización por su id. Un id de otra organización, inexistente o de alguien ya
 * quitado da lo mismo: «no encontrado», sin revelar nada.
 */
export async function loadMember(active: ActiveTenant, memberId: string): Promise<MemberLookup> {
  const list = await loadMembers(active);
  if (!list.ok) return { status: "error" };
  const member = list.members.find((candidate) => candidate.memberId === memberId);
  return member ? { status: "ok", member } : { status: "not_found" };
}
