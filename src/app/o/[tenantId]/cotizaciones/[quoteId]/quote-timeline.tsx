import { formatDateTime } from "@/lib/format-date";
import type { TimelineEntry } from "@/lib/quotes/timeline";

/** Historia de la cotización, en orden y de solo lectura (PROYECTO.md §8.5). */
export function QuoteTimeline({ entries }: { entries: TimelineEntry[] | null }) {
  return (
    <section
      aria-label="Historial de la cotización"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
      data-testid="quote-timeline"
    >
      <h2 className="text-lg">Historial</h2>
      {entries === null ? (
        <p className="text-fg-muted">No pudimos cargar el historial. Recarga la página.</p>
      ) : entries.length === 0 ? (
        <p className="text-fg-muted">Todavía no hay movimientos.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              data-testid="timeline-entry"
              className="flex flex-col gap-0.5 border-l-2 border-border pl-3"
            >
              <span className="font-medium text-fg">{entry.text}</span>
              <span className="text-sm text-fg-subtle tabular-nums">
                {formatDateTime(entry.occurredAt)}
                {entry.actorName ? ` · ${entry.actorName}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
