import "server-only";
import { z } from "zod";
import { serverLog } from "@/lib/log/server-log";
import {
  QUOTABLE_CATALOG_LIMIT,
  QUOTABLE_IDS_LIMIT,
  QUOTABLE_SEARCH_MAX_LENGTH,
} from "./catalog-limits";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";

/**
 * ÚNICO lugar desde donde el cotizador lee el catálogo para ofrecer servicios (cotizaciones-y-calculo.md §5), junto con
 * `loadActiveCatalog` de `src/lib/intake/convert-lines.ts` (convertir una solicitud): las TRES lecturas (la lista, un servicio y los de una
 * solicitud) pasan por `public.quotable_catalog_items`, que aplica la regla de servicios por comercial (H-042). El cálculo nunca lee el
 * catálogo: la línea copia nombre, precio, unidad y trato tributario al agregarse.
 */

export { QUOTABLE_CATALOG_LIMIT, QUOTABLE_SEARCH_MAX_LENGTH };

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

/**
 * Servicios activos de la organización activa que esta persona puede cotizar, por nombre (parcial), hasta 20. Lee
 * `public.quotable_catalog_items`: la base decide (con la regla de «servicios por comercial» de H-042) y la misma regla se exige al
 * guardar una línea nueva, así lo que se ve y lo que se guarda no pueden diferir. La búsqueda escapa `%` y `_` en la base.
 */
export async function listQuotableCatalogItems(
  active: ActiveTenant,
  term: string,
): Promise<QuotableCatalogItem[]> {
  const search = term.trim().slice(0, QUOTABLE_SEARCH_MAX_LENGTH);
  const { data, error } = await active.supabase.rpc("quotable_catalog_items", {
    p_search: search,
    p_ids: null,
  });
  if (error || !data) {
    await serverLog("error", "quote_catalog_search_failed", { code: error?.code });
    return [];
  }
  return (data as CatalogRow[]).map(toQuotable);
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
 * servicio que no existe, está desactivado, es de otra organización o NO está entre los que esta persona puede cotizar (H-042) da
 * `missing` (todos lo mismo: no se revela cuál); un fallo de la base, `failed`. Actualizar una línea la reemplaza por una NUEVA, y la
 * base exige la regla de servicios por comercial a las líneas nuevas: por eso esta lectura tampoco ofrece lo que no se puede cotizar.
 */
export async function getQuotableCatalogItem(
  active: ActiveTenant,
  itemId: string,
): Promise<CatalogItemLookup> {
  const { data, error } = await active.supabase.rpc("quotable_catalog_items", {
    p_search: "",
    p_ids: [itemId],
  });
  if (error) {
    await serverLog("error", "quote_catalog_item_failed", { code: error.code });
    return { status: "failed" };
  }
  const row = ((data ?? []) as CatalogRow[])[0];
  return row ? { status: "found", item: toQuotable(row) } : { status: "missing" };
}

/** Los servicios que esta persona puede cotizar (H-042): si su organización le dejó una lista y cuántos servicios activos tiene. */
export type MyCatalogScope = { limited: boolean; allowedCount: number | null };

const myScopeSchema = z.object({
  limited: z.boolean(),
  allowed_count: z.number().int().min(0).nullable(),
});

/** `null` si no se pudo leer: la pantalla no marca nada y la base exige la regla igual al guardar. */
export async function loadMyCatalogScope(active: ActiveTenant): Promise<MyCatalogScope | null> {
  const { data, error } = await active.supabase.rpc("my_catalog_scope");
  if (error) {
    await serverLog("error", "quote_catalog_scope_failed", { code: error.code });
    return null;
  }
  const parsed = myScopeSchema.safeParse(data);
  if (!parsed.success) {
    await serverLog("error", "quote_catalog_scope_failed", { code: "shape" });
    return null;
  }
  return { limited: parsed.data.limited, allowedCount: parsed.data.allowed_count };
}

/**
 * De estos servicios (ACTIVOS: los desactivados ya tienen su propio aviso), los que esta persona hoy NO puede cotizar. Sirve para marcar,
 * en una cotización abierta, las líneas cuyo servicio salió de su lista: se conservan, pero se avisa. `null` si no se pudo leer.
 */
export async function listNotAllowedCatalogIds(
  active: ActiveTenant,
  activeCatalogIds: readonly string[],
): Promise<string[] | null> {
  const ids = [...new Set(activeCatalogIds)];
  const allowed = new Set<string>();
  for (let start = 0; start < ids.length; start += QUOTABLE_IDS_LIMIT) {
    const { data, error } = await active.supabase.rpc("quotable_catalog_items", {
      p_search: "",
      p_ids: ids.slice(start, start + QUOTABLE_IDS_LIMIT),
    });
    if (error || !data) {
      await serverLog("error", "quote_catalog_allowed_failed", { code: error?.code });
      return null;
    }
    for (const row of data as { id: string }[]) allowed.add(row.id);
  }
  return ids.filter((id) => !allowed.has(id));
}
