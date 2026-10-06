import "server-only";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { describeQuoteEvent } from "./timeline-text";

/** Eventos que se muestran por cotización (la línea de tiempo completa llega con M12). */
export const TIMELINE_LIMIT = 100;

export type TimelineEntry = {
  id: number;
  occurredAt: string;
  text: string;
  /** Nombre de quien lo hizo; `null` si lo hizo el sistema o el cliente. */
  actorName: string | null;
};

/**
 * Historia de una cotización, en orden (PROYECTO.md §8.5). Es de solo lectura: `quote_events` solo
 * acepta agregar. Nunca trae datos personales (la base lo exige); aquí solo se les pone texto.
 */
export async function listQuoteTimeline(
  active: ActiveTenant,
  quoteId: string,
): Promise<TimelineEntry[] | null> {
  const { data, error } = await active.supabase
    .from("quote_events")
    .select("id, occurred_at, type, actor_user_id")
    .eq("tenant_id", active.tenantId)
    .eq("quote_id", quoteId)
    .order("occurred_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(TIMELINE_LIMIT);
  if (error || !data) {
    await serverLog("error", "quote_timeline_failed", { code: error?.code });
    return null;
  }
  const rows = data as {
    id: number;
    occurred_at: string;
    type: string;
    actor_user_id: string | null;
  }[];
  const userIds = [...new Set(rows.map((row) => row.actor_user_id).filter((id) => id !== null))];
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profiles } = await active.supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", userIds as string[]);
    for (const row of (profiles ?? []) as { user_id: string; full_name: string }[]) {
      names.set(row.user_id, row.full_name);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    text: describeQuoteEvent(row.type),
    actorName: row.actor_user_id ? (names.get(row.actor_user_id) ?? null) : null,
  }));
}
