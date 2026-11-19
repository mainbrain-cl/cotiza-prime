import "server-only";
import { isValidMaxDiscountBp } from "@/lib/quotes/line-rules";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";

/**
 * Lo que `/enviar` y el editor necesitan saber, de HOY, para las reglas de precio y descuento (H-041): el descuento
 * máximo de la organización (los servicios con el precio bloqueado los lee `getQuote`, en la misma consulta del catálogo). Se lee con el pase de la persona y la
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
