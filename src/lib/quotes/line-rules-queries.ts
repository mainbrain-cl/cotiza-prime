import "server-only";
import { isValidMaxDiscountBp } from "@/lib/quotes/line-rules";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";

/**
 * Lo que `/enviar` necesita saber, de HOY, para calcular el bloqueo por las reglas de precio y descuento (H-041): el descuento
 * máximo de la organización y qué servicios del catálogo tienen el precio bloqueado. Se lee con el pase de la persona y la
 * organización activa (nunca con la llave maestra). `null` si no se pudo leer: quien llama lo trata como un fallo (no se deja
 * enviar), no como «sin tope» ni «sin candados».
 */

export async function loadMaxDiscountBp(
  active: ActiveTenant,
): Promise<{ maxDiscountBp: number | null } | null> {
  const { data, error } = await active.supabase
    .from("tenants")
    .select("max_discount_bp")
    .eq("tenant_id", active.tenantId)
    .maybeSingle();
  if (error || !data) {
    await serverLog("error", "max_discount_read_failed", { code: error?.code ?? "no_row" });
    return null;
  }
  const value = (data as { max_discount_bp: number | null }).max_discount_bp;
  if (!isValidMaxDiscountBp(value)) {
    await serverLog("error", "max_discount_read_failed", { code: "shape" });
    return null;
  }
  return { maxDiscountBp: value };
}

/** Los servicios con el precio bloqueado hoy, entre los dados (aunque estén desactivados: el candado sigue valiendo). */
export async function loadLockedCatalogIds(
  active: ActiveTenant,
  catalogItemIds: readonly string[],
): Promise<Set<string> | null> {
  const ids = [...new Set(catalogItemIds)];
  if (ids.length === 0) return new Set();
  const { data, error } = await active.supabase
    .from("catalog_items")
    .select("id")
    .eq("tenant_id", active.tenantId)
    .eq("price_locked", true)
    .in("id", ids);
  if (error || !data) {
    await serverLog("error", "catalog_locks_read_failed", { code: error?.code });
    return null;
  }
  return new Set((data as { id: string }[]).map((row) => row.id));
}
