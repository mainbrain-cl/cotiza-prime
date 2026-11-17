import "server-only";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";

/**
 * ÚNICO lugar desde donde el cotizador lee el catálogo para ofrecer servicios (cotizaciones-y-calculo.md §5).
 * H-042 (permisos por servicio) cambia solo este archivo. El cálculo nunca lee el catálogo: la línea
 * copia nombre, precio, unidad y trato tributario al agregarse.
 */

export const QUOTABLE_CATALOG_LIMIT = 20;
export const QUOTABLE_SEARCH_MAX_LENGTH = 100;

export type QuotableCatalogItem = {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  unitPriceClp: number;
  taxTreatment: "taxable" | "exempt";
  /** El precio está bloqueado en el catálogo (H-041): el Comercial no puede cambiarlo al cotizar. */
  priceLocked: boolean;
};

type CatalogRow = {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  unit_price_clp: number;
  tax_treatment: "taxable" | "exempt";
  price_locked: boolean;
};

/** Escapa los comodines de `ilike` para que "50%" se busque tal cual. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Servicios activos de la organización activa, por nombre (parcial), hasta 20. */
export async function listQuotableCatalogItems(
  active: ActiveTenant,
  term: string,
): Promise<QuotableCatalogItem[]> {
  const search = term.trim().slice(0, QUOTABLE_SEARCH_MAX_LENGTH);
  let query = active.supabase
    .from("catalog_items")
    .select("id, name, description, unit, unit_price_clp, tax_treatment, price_locked")
    .eq("tenant_id", active.tenantId)
    .eq("is_active", true)
    .order("name", { ascending: true })
    .limit(QUOTABLE_CATALOG_LIMIT);
  if (search !== "") query = query.ilike("name", `%${escapeLike(search)}%`);
  const { data, error } = await query;
  if (error || !data) {
    await serverLog("error", "quote_catalog_search_failed", { code: error?.code });
    return [];
  }
  return (data as CatalogRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    unit: row.unit,
    unitPriceClp: row.unit_price_clp,
    taxTreatment: row.tax_treatment,
    priceLocked: row.price_locked,
  }));
}
