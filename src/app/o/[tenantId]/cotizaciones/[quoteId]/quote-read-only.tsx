import { TAX_TREATMENTS, unitLabel } from "@/lib/catalog/schemas";
import { formatClp } from "@/lib/money/clp";
import { formatPercentBp, formatQuantity } from "@/lib/quotes/format";
import type { QuoteItemRow, QuoteRow } from "@/lib/quotes/queries";
import { describeValidity, todayInChile } from "@/lib/quotes/validity";
import { TotalsPanel } from "./totals-panel";

const taxLabel = (value: string) => TAX_TREATMENTS.find((t) => t.value === value)?.label ?? value;

function discountText(item: QuoteItemRow): string | null {
  if (item.discount_kind === "percent") {
    return `Descuento ${formatPercentBp(item.discount_value)}% (−${formatClp(item.discount_clp)})`;
  }
  if (item.discount_kind === "amount") return `Descuento −${formatClp(item.discount_clp)}`;
  return null;
}

function validityText(quote: QuoteRow): string {
  if (quote.valid_until)
    return describeValidity({ mode: "date", date: quote.valid_until }, todayInChile(), false);
  if (quote.validity_mode === "days" && quote.validity_days) {
    return describeValidity({ mode: "days", days: quote.validity_days }, todayInChile(), false);
  }
  return "Sin vigencia definida.";
}

/** Vista de solo lectura: lo guardado, tal cual (nunca se recalcula aquí). */
export function QuoteReadOnly({
  quote,
  items,
  inactiveCatalogIds,
}: {
  quote: QuoteRow;
  items: QuoteItemRow[];
  inactiveCatalogIds: string[];
}) {
  const inactive = new Set(inactiveCatalogIds);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" data-testid="quote-read-only">
      <section aria-label="Líneas de la cotización" className="flex flex-col gap-3">
        <h2 className="text-lg">Líneas</h2>
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border-strong bg-surface p-6 text-center text-fg-muted">
            Esta cotización todavía no tiene líneas.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {items.map((item) => (
              <li
                key={item.id}
                data-testid="quote-line"
                className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4 shadow-1"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="font-semibold text-fg">{item.name}</span>
                  <span data-testid="line-total" className="font-semibold text-fg tabular-nums">
                    {formatClp(item.line_total_clp)}
                  </span>
                </div>
                {item.description ? <p className="text-fg-muted">{item.description}</p> : null}
                <p className="text-sm text-fg-muted tabular-nums">
                  {formatQuantity(item.quantity_milli)} × {formatClp(item.unit_price_clp)} ·{" "}
                  {unitLabel(item.unit)} · {taxLabel(item.tax_treatment)}
                </p>
                {discountText(item) ? (
                  <p className="text-sm text-fg-muted tabular-nums">{discountText(item)}</p>
                ) : null}
                {item.catalog_item_id && inactive.has(item.catalog_item_id) ? (
                  <p className="text-sm text-fg-muted">Ya no está en el catálogo.</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section
        aria-label="Condiciones de la oferta"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5 lg:col-start-1"
      >
        <h2 className="text-lg">Condiciones de la oferta</h2>
        <p data-testid="validity-summary" className="text-fg-muted">
          {validityText(quote)}
        </p>
        {quote.observations ? (
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold text-fg">Observaciones</h3>
            <p className="whitespace-pre-wrap text-fg-muted">{quote.observations}</p>
          </div>
        ) : null}
        {quote.conditions ? (
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold text-fg">Condiciones comerciales</h3>
            <p className="whitespace-pre-wrap text-fg-muted">{quote.conditions}</p>
          </div>
        ) : null}
      </section>
      <aside className="lg:sticky lg:top-6 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
        <TotalsPanel
          totals={{
            subtotalClp: quote.subtotal_clp,
            globalDiscountClp: quote.global_discount_clp,
            netTaxableClp: quote.net_taxable_clp,
            netExemptClp: quote.net_exempt_clp,
            taxClp: quote.tax_clp,
            totalClp: quote.total_clp,
            appliedDiscountsClp: quote.line_discounts_clp + quote.global_discount_clp,
            taxRateBp: quote.tax_rate_bp,
          }}
        />
      </aside>
    </div>
  );
}
