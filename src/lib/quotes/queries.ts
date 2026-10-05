import "server-only";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid } from "@/lib/tenant/constants";

/** Cotizaciones por página de la lista mínima de H-025 (filtros y paginación llegan con H-032). */
export const QUOTES_LIST_LIMIT = 50;

// Siempre columnas explícitas: `quote_items` no entrega `unit_cost_clp` (el costo es solo del equipo).
const QUOTE_COLUMNS =
  "id, number_display, version, status, revision, customer_id, created_by, created_at, updated_at, tax_rate_bp, " +
  "global_discount_kind, global_discount_value, subtotal_taxable_clp, subtotal_exempt_clp, subtotal_clp, " +
  "line_discounts_clp, global_discount_clp, global_discount_taxable_clp, global_discount_exempt_clp, " +
  "net_taxable_clp, net_exempt_clp, tax_clp, total_clp";
const ITEM_COLUMNS =
  "id, position, catalog_item_id, catalog_unit_price_clp, name, description, unit, tax_treatment, " +
  "quantity_milli, unit_price_clp, discount_kind, discount_value, gross_clp, discount_clp, line_total_clp";

export type QuoteRow = {
  id: string;
  number_display: string;
  version: number;
  status: string;
  revision: number;
  customer_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  tax_rate_bp: number;
  global_discount_kind: "none" | "percent" | "amount";
  global_discount_value: number;
  subtotal_taxable_clp: number;
  subtotal_exempt_clp: number;
  subtotal_clp: number;
  line_discounts_clp: number;
  global_discount_clp: number;
  global_discount_taxable_clp: number;
  global_discount_exempt_clp: number;
  net_taxable_clp: number;
  net_exempt_clp: number;
  tax_clp: number;
  total_clp: number;
};

export type QuoteItemRow = {
  id: string;
  position: number;
  catalog_item_id: string | null;
  catalog_unit_price_clp: number | null;
  name: string;
  description: string | null;
  unit: string;
  tax_treatment: "taxable" | "exempt";
  quantity_milli: number;
  unit_price_clp: number;
  discount_kind: "none" | "percent" | "amount";
  discount_value: number;
  gross_clp: number;
  discount_clp: number;
  line_total_clp: number;
};

export type QuoteListItem = {
  id: string;
  numberDisplay: string;
  version: number;
  status: string;
  customerName: string;
  authorName: string;
  totalClp: number;
  createdAt: string;
};

/** Nombre de las personas de la organización (visible para todos los miembros). */
async function authorNames(active: ActiveTenant, userIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (userIds.length === 0) return names;
  const { data } = await active.supabase
    .from("profiles")
    .select("user_id, full_name")
    .in("user_id", userIds);
  for (const row of (data ?? []) as { user_id: string; full_name: string }[]) {
    names.set(row.user_id, row.full_name);
  }
  return names;
}

/** Las últimas cotizaciones de la organización activa (todos los roles ven todas, decisión 009). */
export async function listRecentQuotes(active: ActiveTenant): Promise<QuoteListItem[] | null> {
  const { data, error } = await active.supabase
    .from("quotes")
    .select("id, number_display, version, status, customer_id, created_by, total_clp, created_at")
    .eq("tenant_id", active.tenantId)
    .order("created_at", { ascending: false })
    .limit(QUOTES_LIST_LIMIT);
  if (error || !data) {
    await serverLog("error", "quotes_list_failed", { code: error?.code });
    return null;
  }
  const rows = data as {
    id: string;
    number_display: string;
    version: number;
    status: string;
    customer_id: string;
    created_by: string;
    total_clp: number;
    created_at: string;
  }[];
  const customerIds = [...new Set(rows.map((row) => row.customer_id))];
  const customers = new Map<string, string>();
  if (customerIds.length > 0) {
    const { data: customerRows } = await active.supabase
      .from("customers")
      .select("id, display_name")
      .eq("tenant_id", active.tenantId)
      .in("id", customerIds);
    for (const row of (customerRows ?? []) as { id: string; display_name: string }[]) {
      customers.set(row.id, row.display_name);
    }
  }
  const authors = await authorNames(active, [...new Set(rows.map((row) => row.created_by))]);
  return rows.map((row) => ({
    id: row.id,
    numberDisplay: row.number_display,
    version: row.version,
    status: row.status,
    customerName: customers.get(row.customer_id) ?? "Cliente",
    authorName: authors.get(row.created_by) ?? "—",
    totalClp: row.total_clp,
    createdAt: row.created_at,
  }));
}

export type QuoteDetail = {
  quote: QuoteRow;
  items: QuoteItemRow[];
  authorName: string;
  /** Servicios del catálogo de las líneas que hoy están desactivados (informativo: "Ya no está en el catálogo"). */
  inactiveCatalogIds: string[];
};

/** Una cotización de la organización activa con sus líneas, o `null` si no existe en ella. */
export async function getQuote(active: ActiveTenant, quoteId: string): Promise<QuoteDetail | null> {
  if (!isUuid(quoteId)) return null;
  const { data, error } = await active.supabase
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq("tenant_id", active.tenantId)
    .eq("id", quoteId)
    .maybeSingle();
  if (error) {
    await serverLog("error", "quote_get_failed", { code: error.code });
    return null;
  }
  if (!data) return null;
  const quote = data as unknown as QuoteRow;

  const { data: itemRows, error: itemsError } = await active.supabase
    .from("quote_items")
    .select(ITEM_COLUMNS)
    .eq("tenant_id", active.tenantId)
    .eq("quote_id", quote.id)
    .order("position", { ascending: true });
  if (itemsError) {
    await serverLog("error", "quote_items_failed", { code: itemsError.code });
    return null;
  }
  const items = (itemRows ?? []) as unknown as QuoteItemRow[];

  const catalogIds = items
    .map((item) => item.catalog_item_id)
    .filter((id): id is string => id !== null);
  let inactiveCatalogIds: string[] = [];
  if (catalogIds.length > 0) {
    const { data: inactive } = await active.supabase
      .from("catalog_items")
      .select("id")
      .eq("tenant_id", active.tenantId)
      .eq("is_active", false)
      .in("id", catalogIds);
    inactiveCatalogIds = ((inactive ?? []) as { id: string }[]).map((row) => row.id);
  }
  const authors = await authorNames(active, [quote.created_by]);
  return {
    quote,
    items,
    authorName: authors.get(quote.created_by) ?? "—",
    inactiveCatalogIds,
  };
}
