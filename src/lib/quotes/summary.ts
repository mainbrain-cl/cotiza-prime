/**
 * Resumen por estado del inicio (docs/PROYECTO.md §8.8): cuántas cotizaciones hay en cada grupo y
 * por cuánto dinero. Función pura: la consulta a la base vive en `summary-query.ts`.
 */

import type { QuoteStatus } from "@/components/ui/status-badge";
import { toBadgeStatus } from "./format";

export type SummaryGroupId = "drafts" | "sent" | "accepted" | "to_collect";

export type SummaryGroup = {
  id: SummaryGroupId;
  label: string;
  help: string;
  statuses: readonly QuoteStatus[];
};

/** Los cuatro grupos del inicio, en el orden en que se muestran. */
export const SUMMARY_GROUPS: readonly SummaryGroup[] = [
  {
    id: "drafts",
    label: "Borradores",
    help: "Se están armando",
    statuses: ["draft", "changes_requested"],
  },
  {
    id: "sent",
    label: "Enviadas",
    help: "Esperando al cliente",
    statuses: ["pending_approval", "sent", "viewed"],
  },
  {
    id: "accepted",
    label: "Aceptadas",
    help: "El cliente dijo que sí",
    statuses: ["accepted"],
  },
  {
    id: "to_collect",
    label: "Por cobrar",
    help: "Falta una transferencia",
    statuses: ["pending_payment", "pending_deposit", "deposit_paid", "pending_balance"],
  },
] as const;

export type SummaryRow = { status: string; total_clp: number };

export type SummaryEntry = { id: SummaryGroupId; count: number; amountClp: number };

export type QuoteSummary = {
  /** Todas las cotizaciones leídas, de cualquier estado. */
  total: number;
  entries: SummaryEntry[];
};

export function summarizeQuotes(rows: readonly SummaryRow[]): QuoteSummary {
  const entries: SummaryEntry[] = SUMMARY_GROUPS.map((group) => ({
    id: group.id,
    count: 0,
    amountClp: 0,
  }));
  for (const row of rows) {
    const status = toBadgeStatus(row.status);
    const index = SUMMARY_GROUPS.findIndex((group) => group.statuses.includes(status));
    if (index === -1) continue;
    entries[index].count += 1;
    entries[index].amountClp += row.total_clp;
  }
  return { total: rows.length, entries };
}
