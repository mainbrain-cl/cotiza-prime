import type { SupabaseClient } from "@supabase/supabase-js";
import { logAuditEvent } from "@/lib/audit/log";

/** Organizaciones activas de la persona. Con la sesión parcial (falta el código) la base no entrega ninguna. */
export async function activeTenantIdsOf(
  supabase: SupabaseClient,
  userId: string,
): Promise<string[]> {
  const { data: memberships } = await supabase
    .from("members")
    .select("tenant_id, tenants!inner(status, kind)")
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("tenants.status", "active")
    .eq("tenants.kind", "organization");
  return ((memberships ?? []) as { tenant_id: string }[]).map((m) => m.tenant_id);
}

/**
 * Un ingreso (`session.login`) por cada organización activa de la persona: así cada Dueño ve cuándo entra su equipo.
 * Se escribe cuando la sesión ya es COMPLETA: sin verificación en dos pasos, tras la contraseña; con ella, DESPUÉS del
 * código (con la sesión parcial la base no entrega ninguna organización). Usa el mismo cliente que acaba de ingresar.
 */
export async function logTenantLogins(supabase: SupabaseClient, userId: string): Promise<void> {
  for (const tenantId of await activeTenantIdsOf(supabase, userId)) {
    await logAuditEvent({
      action: "session.login",
      result: "success",
      actorUserId: userId,
      tenantId,
    });
  }
}
