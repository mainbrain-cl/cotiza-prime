import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { TONE_CLASSES } from "@/components/ui/status-badge";
import { snippetExcerpt, type SnippetGroup } from "@/lib/snippets/groups";
import { cn } from "@/lib/utils";

/**
 * Los textos guardados, agrupados por tipo. Cada texto es una tarjeta que lleva a su pantalla de editar:
 * sirve igual en teléfono (sin desplazamiento horizontal) y en escritorio.
 */
export function SnippetList({
  groups,
  hrefFor,
}: {
  groups: SnippetGroup[];
  hrefFor: (snippetId: string) => string;
}) {
  return (
    <div className="flex flex-col gap-8" data-testid="snippet-list">
      {groups.map((group) => (
        <section
          key={group.kind}
          aria-labelledby={`snippet-group-${group.kind}`}
          data-testid={`snippet-group-${group.kind}`}
          className="flex flex-col gap-3"
        >
          <h2 id={`snippet-group-${group.kind}`} className="text-lg">
            {group.label}{" "}
            <span className="text-sm font-normal text-fg-muted">({group.rows.length})</span>
          </h2>
          <ul className="grid grid-cols-1 gap-3">
            {group.rows.map((row) => (
              <li key={row.id} className="min-w-0">
                <Link
                  href={hrefFor(row.id)}
                  data-testid="snippet-row"
                  className="flex min-h-11 min-w-0 items-center gap-4 rounded-lg border border-border bg-surface px-4 py-4 shadow-1 transition-[border-color,box-shadow] duration-(--dur-fast) ease-ios outline-none hover:border-accent focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span
                        data-testid="snippet-row-name"
                        className="font-semibold break-words text-fg"
                      >
                        {row.name}
                      </span>
                      {row.isDefault ? (
                        <span
                          data-testid="snippet-row-default"
                          className={cn(
                            "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap",
                            TONE_CLASSES.accent.badge,
                          )}
                        >
                          <span
                            aria-hidden
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              TONE_CLASSES.accent.dot,
                            )}
                          />
                          Texto inicial
                        </span>
                      ) : null}
                    </span>
                    <span className="text-sm break-words text-fg-muted">
                      {snippetExcerpt(row.body)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-accent">
                    Editar
                    <ChevronRight aria-hidden className="size-5 text-fg-subtle" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
