import "server-only";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";

/**
 * ¿La cotización tiene algún enlace del cliente activo (enviado y no revocado)? Solo lee dos columnas
 * de fechas: nunca el sello del token. Si no se puede leer, se asume que sí (no se esconde la opción).
 */
export async function hasActiveShareLink(active: ActiveTenant, quoteId: string): Promise<boolean> {
  const { count, error } = await active.supabase
    .from("share_links")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", active.tenantId)
    .eq("quote_id", quoteId)
    .not("activated_at", "is", null)
    .is("revoked_at", null);
  if (error) {
    await serverLog("error", "share_link_active_failed", { code: error.code });
    return true;
  }
  return (count ?? 0) > 0;
}
