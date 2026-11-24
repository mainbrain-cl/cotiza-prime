import "server-only";
import { unitLabel } from "@/lib/catalog/schemas";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import {
  NO_CATALOG_SCOPE,
  SCOPE_CATALOG_LIMIT,
  type CatalogScopeMode,
  type CatalogScopeRecord,
  type ScopeCatalogItem,
} from "./catalog-scope-model";

/**
 * Lo que la sección «Servicios que puede cotizar» de la ficha de un miembro lee (H-042). Todo con el pase de la persona (nunca con la
 * llave maestra): las dos tablas de la regla solo las leen quienes manejan el equipo (la pantalla además comprueba el permiso ANTES
 * de llamar aquí) y el catálogo lo lee cualquier miembro. Nada de esto se escribe en un log (solo códigos).
 */

type ScopeRow = {
  mode: CatalogScopeMode;
  revision: number;
  updated_by: string | null;
  updated_at: string | null;
};
type CatalogRow = {
  id: string;
  name: string;
  unit: string;
  unit_price_clp: number;
  is_active: boolean;
};

export type CatalogScopeLookup =
  | {
      status: "ok";
      scope: CatalogScopeRecord;
      catalog: ScopeCatalogItem[];
      /** El catálogo es más largo que lo que se trajo. */
      catalogTruncated: boolean;
    }
  | { status: "error" };

/**
 * La regla de UN miembro de esta organización y, si se pide, el catálogo (activos y desactivados, por nombre, hasta
 * `SCOPE_CATALOG_LIMIT`). A un rol al que no se le limita no se le muestra la lista, así que para él no se lee el catálogo
 * (`withCatalog: false`): solo la regla, para avisar si quedó una guardada de antes.
 */
export async function loadCatalogScope(
  active: ActiveTenant,
  memberId: string,
  options: { withCatalog?: boolean } = {},
): Promise<CatalogScopeLookup> {
  const withCatalog = options.withCatalog ?? true;
  const [scopeResult, itemsResult, catalogResult] = await Promise.all([
    active.supabase
      .from("member_catalog_scopes")
      .select("mode, revision, updated_by, updated_at")
      .eq("tenant_id", active.tenantId)
      .eq("member_id", memberId)
      .maybeSingle(),
    active.supabase
      .from("member_catalog_scope_items")
      .select("catalog_item_id")
      .eq("tenant_id", active.tenantId)
      .eq("member_id", memberId),
    withCatalog
      ? active.supabase
          .from("catalog_items")
          .select("id, name, unit, unit_price_clp, is_active")
          .eq("tenant_id", active.tenantId)
          .order("name", { ascending: true })
          .limit(SCOPE_CATALOG_LIMIT)
      : Promise.resolve({ data: [] as CatalogRow[], error: null }),
  ]);
  const failed = scopeResult.error ?? itemsResult.error ?? catalogResult.error;
  if (failed) {
    await serverLog("error", "catalog_scope_read_failed", { code: failed.code });
    return { status: "error" };
  }
  const row = scopeResult.data as ScopeRow | null;
  const catalogRows = (catalogResult.data ?? []) as CatalogRow[];
  const catalog = catalogRows.map((item): ScopeCatalogItem => ({
    id: item.id,
    name: item.name,
    unitLabel: unitLabel(item.unit),
    unitPriceClp: item.unit_price_clp,
    isActive: item.is_active,
  }));
  const catalogTruncated = catalogRows.length >= SCOPE_CATALOG_LIMIT;
  if (!row) return { status: "ok", scope: NO_CATALOG_SCOPE, catalog, catalogTruncated };

  // «Cambiado por Ana»: el nombre del perfil de quien la cambió (lo leen quienes manejan el equipo, de cualquier miembro de la organización).
  let updatedByName: string | null = null;
  if (row.updated_by) {
    const profile = await active.supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", row.updated_by)
      .maybeSingle();
    updatedByName = (profile.data as { full_name: string | null } | null)?.full_name ?? null;
  }
  const itemIds = ((itemsResult.data ?? []) as { catalog_item_id: string }[]).map(
    (item) => item.catalog_item_id,
  );
  return {
    status: "ok",
    scope: {
      mode: row.mode,
      revision: row.revision,
      itemIds,
      updatedByName,
      updatedAt: row.updated_at,
    },
    catalog,
    catalogTruncated,
  };
}
