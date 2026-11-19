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

function toQuotable(row: CatalogRow): QuotableCatalogItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    unit: row.unit,
    unitPriceClp: row.unit_price_clp,
    taxTreatment: row.tax_treatment,
    priceLocked: row.price_locked,
  };
}

/** Lo que responde la lectura de UN servicio: lo encontró, no existe para esta persona, o no se pudo leer (distintos mensajes). */
export type CatalogItemLookup =
  { status: "found"; item: QuotableCatalogItem } | { status: "missing" } | { status: "failed" };

/**
 * Un servicio activo de la organización activa por su identificador, tal como está HOY en el catálogo (precio y candado
 * vigentes). Sirve para poner al día una línea cuando el precio o el candado cambiaron con la cotización abierta (H-041). Un
 * servicio que no existe, está desactivado o es de otra organización da `missing` (todos lo mismo: no se revela cuál); un fallo de la
 * base, `failed`.
 *
 * H-042 (servicios por comercial): esta función y `listQuotableCatalogItems` filtran por separado; las DOS tienen que dejar de
 * ofrecer lo que la persona no puede cotizar. Actualizar una línea la reemplaza por una NUEVA, y el gancho se aplica a las nuevas.
 */
export async function getQuotableCatalogItem(
  active: ActiveTenant,
  itemId: string,
): Promise<CatalogItemLookup> {
  const { data, error } = await active.supabase
    .from("catalog_items")
    .select("id, name, description, unit, unit_price_clp, tax_treatment, price_locked")
    .eq("tenant_id", active.tenantId)
    .eq("id", itemId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    await serverLog("error", "quote_catalog_item_failed", { code: error.code });
    return { status: "failed" };
  }
  return data ? { status: "found", item: toQuotable(data as CatalogRow) } : { status: "missing" };
}
