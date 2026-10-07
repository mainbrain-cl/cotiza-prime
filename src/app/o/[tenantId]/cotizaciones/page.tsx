import { FileText, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormAlert } from "@/components/ui/form-controls";
import { DeliveryBadge } from "@/components/ui/delivery-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate } from "@/lib/format-date";
import { formatClp } from "@/lib/money/clp";
import { getDeliveryByQuote } from "@/lib/quotes/delivery";
import { needsAttention, type QuoteDelivery } from "@/lib/quotes/delivery-model";
import { formatQuoteNumber, toBadgeStatus } from "@/lib/quotes/format";
import {
  QUOTE_SCOPE_PARAM,
  parseQuoteScope,
  quoteListHref,
  type QuoteListScope,
} from "@/lib/quotes/list-scope";
import { listRecentQuotes, QUOTES_LIST_LIMIT } from "@/lib/quotes/queries";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Cotizaciones · Cotiza Prime" };

const WRITER_ROLES = ["owner", "admin", "sales"];

/** Estado de la cotización; si su correo rebotó, además el aviso (solo lo que pide atención). */
function StatusCell({ status, delivery }: { status: string; delivery: QuoteDelivery | undefined }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <StatusBadge status={toBadgeStatus(status)} />
      {delivery && needsAttention(delivery) ? (
        <span data-testid="list-bounce">
          <DeliveryBadge status={delivery.status} />
        </span>
      ) : null}
    </span>
  );
}

const SCOPE_OPTIONS: { scope: QuoteListScope; label: string }[] = [
  { scope: "all", label: "Todas" },
  { scope: "mine", label: "Mías" },
];

export default async function QuotesPage({
  params,
  searchParams,
}: PageProps<"/o/[tenantId]/cotizaciones">) {
  const active = await requireActiveTenant((await params).tenantId);
  const scope = parseQuoteScope((await searchParams)[QUOTE_SCOPE_PARAM]);
  const quotes = await listRecentQuotes(active, scope);
  const deliveries = await getDeliveryByQuote(active, quotes?.map((quote) => quote.id) ?? []);
  const listPath = tenantPath(active.tenantId, "cotizaciones");
  const canCreate = WRITER_ROLES.includes(active.role);
  const newPath = tenantPath(active.tenantId, "cotizaciones/nueva");
  const quotePath = (id: string) => tenantPath(active.tenantId, `cotizaciones/${id}`);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl md:text-2xl">Cotizaciones</h1>
          <p className="text-fg-muted">Arma tus cotizaciones y mira en qué quedó cada una.</p>
        </div>
        {canCreate ? (
          <Link href={newPath} className={buttonVariants({ size: "default" })}>
            <Plus aria-hidden />
            Nueva cotización
          </Link>
        ) : null}
      </header>

      <nav aria-label="Qué cotizaciones ver" className="flex items-center gap-2">
        {SCOPE_OPTIONS.map((option) => {
          const current = option.scope === scope;
          return (
            <Link
              key={option.scope}
              href={quoteListHref(listPath, option.scope)}
              aria-current={current ? "page" : undefined}
              data-testid={`scope-${option.scope}`}
              className={cn(
                "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold transition-colors duration-(--dur-fast) ease-ios outline-none focus-visible:ring-3 focus-visible:ring-ring/30 md:min-h-9",
                current
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border-strong bg-surface text-fg-muted hover:text-fg",
              )}
            >
              {option.label}
            </Link>
          );
        })}
      </nav>

      {quotes === null ? (
        <FormAlert>
          No pudimos cargar tus cotizaciones. Recarga la página en unos minutos.
        </FormAlert>
      ) : quotes.length === 0 && scope === "mine" ? (
        <div
          role="status"
          data-testid="no-mine"
          className="rounded-lg border border-border bg-surface p-6 text-center text-fg-muted shadow-1"
        >
          Todavía no armaste ninguna cotización. Elige «Todas» para ver las de tu equipo.
        </div>
      ) : quotes.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="Aún no tienes cotizaciones"
          description="Elige un cliente y arma tu primera cotización con los servicios de tu catálogo."
        >
          {canCreate ? (
            <Link href={newPath} className={buttonVariants({ size: "lg" })}>
              Crear una cotización
            </Link>
          ) : null}
        </EmptyState>
      ) : (
        <>
          {/* Teléfono: tarjetas */}
          <ul className="flex flex-col gap-3 md:hidden" data-testid="quote-cards">
            {quotes.map((quote) => (
              <li key={quote.id}>
                <Link
                  href={quotePath(quote.id)}
                  className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 shadow-1 transition-transform duration-(--dur-fast) ease-ios active:scale-[0.99]"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold text-fg">
                      {formatQuoteNumber(quote.numberDisplay, quote.version)}
                    </span>
                    <StatusCell status={quote.status} delivery={deliveries.get(quote.id)} />
                  </span>
                  <span className="text-fg">{quote.customerName}</span>
                  <span className="flex items-center justify-between text-sm text-fg-muted">
                    <span>
                      {quote.authorName} · {formatDate(quote.createdAt)}
                    </span>
                    <span className="font-semibold text-fg tabular-nums">
                      {formatClp(quote.totalClp)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          {/* Escritorio: tabla */}
          <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface shadow-1 md:block">
            <table className="w-full text-left text-sm" data-testid="quote-table">
              <thead className="bg-surface-2 text-fg-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Número
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Cliente
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">
                    Total
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Estado
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Autor
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Fecha
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {quotes.map((quote) => (
                  <tr key={quote.id} className="hover:bg-surface-2" data-testid="quote-row">
                    <td className="px-4 py-3">
                      <Link
                        href={quotePath(quote.id)}
                        className="font-mono font-semibold text-accent underline-offset-4 hover:underline"
                      >
                        {formatQuoteNumber(quote.numberDisplay, quote.version)}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{quote.customerName}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatClp(quote.totalClp)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusCell status={quote.status} delivery={deliveries.get(quote.id)} />
                    </td>
                    <td className="px-4 py-3">{quote.authorName}</td>
                    <td className="px-4 py-3 tabular-nums">{formatDate(quote.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {quotes.length >= QUOTES_LIST_LIMIT ? (
            <p className="text-sm text-fg-muted">
              Se muestran las últimas {QUOTES_LIST_LIMIT} cotizaciones. La búsqueda y más filtros
              llegan pronto.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
