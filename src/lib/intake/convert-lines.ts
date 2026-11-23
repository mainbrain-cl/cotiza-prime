import "server-only";
import { randomUUID } from "node:crypto";
import { saveQuoteDraftAction } from "@/lib/quotes/actions";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import {
  planLines,
  type CatalogSnapshot,
  type LinePlan,
  type RequestedService,
} from "./convert-model";

/**
 * Líneas de una cotización que nace de una solicitud (H-090). Todo se lee con la sesión de quien
 * convierte: la base decide qué servicios del catálogo ve (solo los de su organización).
 */

type CatalogRow = {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  unit_price_clp: number;
  tax_treatment: "taxable" | "exempt";
  price_locked: boolean;
};

/** Servicios del catálogo, de esta organización, que siguen activos, por id. `null` si no se pudo leer. */
export async function loadActiveCatalog(
  active: ActiveTenant,
  catalogItemIds: readonly string[],
): Promise<Map<string, CatalogSnapshot> | null> {
  const ids = [...new Set(catalogItemIds)];
  const result = new Map<string, CatalogSnapshot>();
  if (ids.length === 0) return result;
  const { data, error } = await active.supabase
    .from("catalog_items")
    .select("id, name, description, unit, unit_price_clp, tax_treatment, price_locked")
    .eq("tenant_id", active.tenantId)
    .eq("is_active", true)
    .in("id", ids);
  if (error || !data) {
    await serverLog("error", "intake_convert_catalog_failed", { code: error?.code });
    return null;
  }
  for (const row of data as CatalogRow[]) {
    result.set(row.id, {
      id: row.id,
      name: row.name,
      description: row.description,
      unit: row.unit,
      unitPriceClp: row.unit_price_clp,
      taxTreatment: row.tax_treatment,
      priceLocked: row.price_locked,
    });
  }
  return result;
}

/** Qué líneas saldrían hoy de esta lista de servicios pedidos. `null` si no se pudo leer el catálogo. */
export async function planRequestLines(
  active: ActiveTenant,
  services: readonly RequestedService[],
): Promise<LinePlan | null> {
  const catalog = await loadActiveCatalog(
    active,
    services.flatMap((s) => (s.catalogItemId ? [s.catalogItemId] : [])),
  );
  if (!catalog) return null;
  return planLines(services, catalog);
}

export type SaveLinesOutcome = { ok: true; skipped: RequestedService[] } | { ok: false };

/**
 * Guarda como borrador las líneas de los servicios del catálogo que siguen activos. Si algo falla, la
 * cotización queda como borrador vacío (el editor ofrece cargar los servicios de la solicitud).
 * Usa el mismo guardado del editor: el servidor recalcula y la base lo comprueba.
 */
export async function saveRequestLines(
  active: ActiveTenant,
  tenantId: string,
  quoteId: string,
  services: readonly RequestedService[],
): Promise<SaveLinesOutcome> {
  const plan = await planRequestLines(active, services);
  if (!plan) return { ok: false };
  if (plan.lines.length === 0) return { ok: true, skipped: plan.skipped };

  const { data: quote, error } = await active.supabase
    .from("quotes")
    .select("revision, customer_id, validity_days")
    .eq("tenant_id", active.tenantId)
    .eq("id", quoteId)
    .maybeSingle();
  if (error || !quote) {
    await serverLog("error", "intake_convert_quote_read_failed", { code: error?.code });
    return { ok: false };
  }
  const row = quote as { revision: number; customer_id: string; validity_days: number | null };
  const saved = await saveQuoteDraftAction(tenantId, quoteId, {
    saveId: randomUUID(),
    expectedRevision: row.revision,
    customerId: row.customer_id,
    globalDiscount: { kind: "none" },
    validity: { mode: "days", days: row.validity_days ?? 15 },
    observations: null,
    conditions: null,
    exclusions: null,
    footerNote: null,
    items: plan.lines.map(({ catalog, quantityMilli }) => ({
      id: randomUUID(),
      catalogItemId: catalog.id,
      name: catalog.name,
      description: catalog.description,
      unit: catalog.unit,
      taxTreatment: catalog.taxTreatment,
      quantityMilli,
      unitPriceClp: catalog.unitPriceClp,
      discount: { kind: "none" },
    })),
  });
  if (saved.status !== "saved") {
    await serverLog("warn", "intake_convert_lines_not_saved", { status: saved.status });
    return { ok: false };
  }
  return { ok: true, skipped: plan.skipped };
}
