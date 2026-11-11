import type { SupabaseClient } from "@supabase/supabase-js";
import { logAuditEvent } from "@/lib/audit/log";

/**
 * Un ingreso (`session.login`) por cada organización activa de la persona: así cada Dueño ve cuándo entra su equipo.
 * Se escribe cuando la sesión ya es COMPLETA: sin verificación en dos pasos, tras la contraseña; con ella, DESPUÉS del
 * código (con la sesión parcial la base no entrega ninguna organización). Usa el mismo cliente que acaba de ingresar.
 */
export async function logTenantLogins(supabase: SupabaseClient, userId: string): Promise<void> {
  const { data: memberships } = await supabase
    .from("members")
    .select("tenant_id, tenants!inner(status, kind)")
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("tenants.status", "active")
    .eq("tenants.kind", "organization");
  for (const membership of (memberships ?? []) as { tenant_id: string }[]) {
    await logAuditEvent({
      action: "session.login",
      result: "success",
      actorUserId: userId,
      tenantId: membership.tenant_id,
    });
  }
}
