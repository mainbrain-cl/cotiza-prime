import { FileText, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormAlert } from "@/components/ui/form-controls";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate } from "@/lib/format-date";
import { formatClp } from "@/lib/money/clp";
import { formatQuoteNumber, toBadgeStatus } from "@/lib/quotes/format";
import { listRecentQuotes, QUOTES_LIST_LIMIT } from "@/lib/quotes/queries";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";

export const metadata: Metadata = { title: "Cotizaciones · Cotiza Prime" };

const WRITER_ROLES = ["owner", "admin", "sales"];

export default async function QuotesPage({ params }: PageProps<"/o/[tenantId]/cotizaciones">) {
  const active = await requireActiveTenant((await params).tenantId);
  const quotes = await listRecentQuotes(active);
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

      {quotes === null ? (
        <FormAlert>
          No pudimos cargar tus cotizaciones. Recarga la página en unos minutos.
        </FormAlert>
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
                    <StatusBadge status={toBadgeStatus(quote.status)} />
                  </span>
                  <span className="text-fg">{quote.customerName}</span>
                  <span className="flex items-center justify-between text-sm text-fg-muted">
                    <span>{quote.authorName}</span>
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
                      <StatusBadge status={toBadgeStatus(quote.status)} />
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
              Se muestran las últimas {QUOTES_LIST_LIMIT} cotizaciones. Los filtros y la búsqueda
              llegan pronto.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
