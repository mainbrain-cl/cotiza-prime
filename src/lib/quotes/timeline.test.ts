import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn() }));

import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { TIMELINE_LIMIT, listQuoteTimeline } from "./timeline";

type Row = { id: number; occurred_at: string; type: string; actor_user_id: string | null };

/** Base simulada: responde como Postgres, con el orden y el corte que se le pidan. */
function fakeActive(allRows: Row[]) {
  const calls: { order: [string, boolean][]; limit?: number } = { order: [] };
  const query = {
    select: () => query,
    eq: () => query,
    order: (column: string, options: { ascending: boolean }) => {
      calls.order.push([column, options.ascending]);
      return query;
    },
    limit: (n: number) => {
      calls.limit = n;
      const sorted = [...allRows].sort((a, b) => (calls.order[0][1] ? a.id - b.id : b.id - a.id));
      return Promise.resolve({ data: sorted.slice(0, n), error: null });
    },
  };
  const active = {
    tenantId: "t",
    supabase: { from: () => query },
  } as unknown as ActiveTenant;
  return { active, calls };
}

describe("línea de tiempo (M6)", () => {
  it("pide los más nuevos primero, corta y devuelve en orden cronológico", async () => {
    const total = TIMELINE_LIMIT + 30;
    const rows: Row[] = Array.from({ length: total }, (_, index) => ({
      id: index + 1,
      occurred_at: new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString(),
      type: "sent",
      actor_user_id: null,
    }));
    const { active, calls } = fakeActive(rows);
    const entries = (await listQuoteTimeline(active, "q"))!;
    expect(calls.order).toEqual([
      ["occurred_at", false],
      ["id", false],
    ]);
    expect(calls.limit).toBe(TIMELINE_LIMIT);
    expect(entries).toHaveLength(TIMELINE_LIMIT);
    // Se conserva lo último ocurrido y se muestra de más viejo a más nuevo.
    expect(entries.at(-1)!.id).toBe(total);
    expect(entries[0].id).toBe(total - TIMELINE_LIMIT + 1);
    const ids = entries.map((entry) => entry.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});
