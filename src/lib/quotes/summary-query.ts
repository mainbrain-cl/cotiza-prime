import "server-only";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { summarizeQuotes, type QuoteSummary, type SummaryRow } from "./summary";

/** Tope de filas leídas para el resumen. Más adelante lo reemplaza una vista con totales en la base. */
const SUMMARY_ROW_LIMIT = 5000;

/** Resumen por estado de la organización activa, o `null` si no se pudo leer. */
export async function getQuoteSummary(active: ActiveTenant): Promise<QuoteSummary | null> {
  const { data, error } = await active.supabase
    .from("quotes")
    .select("status, total_clp")
    .eq("tenant_id", active.tenantId)
    .limit(SUMMARY_ROW_LIMIT);
  if (error || !data) {
    await serverLog("error", "quotes_summary_failed", { code: error?.code });
    return null;
  }
  return summarizeQuotes(data as SummaryRow[]);
}
