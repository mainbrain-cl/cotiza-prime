import Link from "next/link";
import { CountUp } from "@/components/react-bits/count-up";
import { SpotlightCard } from "@/components/react-bits/spotlight-card";
import { formatClp } from "@/lib/money/clp";
import { SUMMARY_GROUPS, type QuoteSummary, type SummaryGroupId } from "@/lib/quotes/summary";

const DOT_CLASS: Record<SummaryGroupId, string> = {
  drafts: "bg-fg-subtle",
  sent: "bg-accent",
  accepted: "bg-success",
  to_collect: "bg-warning",
};

/**
 * Resumen por estado del inicio: una tarjeta por grupo, con la cantidad que sube al aparecer y el
 * monto. Cada tarjeta lleva al listado de cotizaciones. Va sobre superficie sólida (pantalla de trabajo).
 */
export function StatusSummary({
  summary,
  quotesPath,
}: {
  summary: QuoteSummary;
  quotesPath: string;
}) {
  return (
    <section aria-labelledby="resumen-por-estado" className="flex flex-col gap-3">
      <h2 id="resumen-por-estado" className="text-lg">
        Resumen por estado
      </h2>
      <ul className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4" data-testid="status-summary">
        {SUMMARY_GROUPS.map((group) => {
          const entry = summary.entries.find((item) => item.id === group.id);
          const count = entry?.count ?? 0;
          const amount = entry?.amountClp ?? 0;
          return (
            <li key={group.id}>
              <SpotlightCard className="h-full">
                <Link
                  href={quotesPath}
                  className="flex h-full min-h-11 flex-col gap-2 rounded-lg p-4 outline-none md:p-5"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-fg-muted">
                    <span aria-hidden className={`size-2 rounded-full ${DOT_CLASS[group.id]}`} />
                    {group.label}
                  </span>
                  <CountUp to={count} className="text-2xl text-fg" />
                  <span className="text-sm text-fg-muted tabular-nums">{formatClp(amount)}</span>
                  <span className="text-xs text-fg-subtle">{group.help}</span>
                </Link>
              </SpotlightCard>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
