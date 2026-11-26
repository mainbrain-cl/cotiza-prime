import { Download } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { ShareDocument } from "@/lib/share/read-model";
import { brandStyle } from "@/lib/share/brand-vars";
import { cn } from "@/lib/utils";

/**
 * La cotización tal como la ve el cliente final (H-030). Dibuja la copia congelada del paquete, con
 * los mismos textos y cifras que el PDF (ya vienen formateados), y manda la marca de la organización:
 * su logo y sus colores. Los datos bancarios llegan solo al aceptar, por `paymentSlot`; no lleva el
 * diseño de Cotiza Prime. Los botones de aceptar y rechazar (H-031) se ponen en el espacio `response-slot`.
 */

export type QuoteViewProps = {
  document: ShareDocument;
  customer: { name: string; detailLines: string[] } | null;
  logoDataUrl: string | null;
  pdfHref: string;
  /** Si el cliente ya respondió, qué respondió y cuándo (texto ya listo para mostrar). */
  responseNotice: string | null;
  /** Los botones de respuesta (H-031) o la confirmación, en el espacio previsto. */
  responseSlot?: ReactNode;
  /** H-053: los datos para pagar, SOLO cuando el cliente ya aceptó (nunca antes). */
  paymentSlot?: ReactNode;
};

const BRAND_BG = "bg-[var(--brand)] text-[var(--on-brand)]";
const BRAND_TEXT = "text-[var(--brand-text)]";

function SectionLabel({ children }: { children: string }) {
  return <h2 className={cn("text-xs tracking-[0.08em] uppercase", BRAND_TEXT)}>{children}</h2>;
}

function Party({ title, name, lines }: { title: string; name: string; lines: string[] }) {
  return (
    <section className="min-w-0 flex-1">
      <SectionLabel>{title}</SectionLabel>
      <p className="mt-1 text-md break-words">{name}</p>
      {lines.map((line, index) => (
        <p key={`${index}:${line}`} className="text-sm break-words text-fg-muted">
          {line}
        </p>
      ))}
    </section>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 py-1",
        strong && cn("mt-2 rounded-sm px-3 py-2 text-md font-semibold", BRAND_BG),
      )}
    >
      <dt className={strong ? "" : "text-fg-muted"}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

export function QuoteView({
  document: doc,
  customer,
  logoDataUrl,
  pdfHref,
  responseNotice,
  responseSlot,
  paymentSlot,
}: QuoteViewProps) {
  const { quote, organization, totals } = doc;
  const notes = [
    { title: "Observaciones", text: doc.observations },
    { title: "Condiciones", text: doc.conditions },
    { title: "Exclusiones", text: doc.exclusions },
    { title: "Forma de pago", text: doc.paymentTerms },
    { title: "Notas", text: doc.footerNote },
  ].filter((note): note is { title: string; text: string } => Boolean(note.text));

  return (
    <div className="customer-light min-h-dvh" style={brandStyle(doc.brand) as CSSProperties}>
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        <article
          data-testid="share-quote"
          className="overflow-hidden rounded-lg border border-border bg-surface shadow-2"
        >
          <header
            className={cn("flex flex-wrap items-center justify-between gap-4 p-5 sm:p-8", BRAND_BG)}
          >
            <div className="flex min-w-0 items-center gap-3">
              {logoDataUrl ? (
                // Logo congelado de la organización, en una dirección `data:` (no hay nada que cargar).
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoDataUrl}
                  alt={`Logo de ${organization.name}`}
                  className="max-h-12 max-w-32 rounded-xs bg-surface object-contain p-1"
                />
              ) : null}
              <h1 className="min-w-0 text-lg font-semibold break-words">{organization.name}</h1>
            </div>
            {/* En el teléfono el número baja a la segunda fila, a la izquierda: «Cotización» queda alineada con él; desde 640 px va a la derecha. */}
            <div className="text-left sm:text-right">
              <p className="text-xs tracking-[0.08em] uppercase opacity-90">Cotización</p>
              <p data-testid="share-quote-number" className="font-mono text-lg font-semibold">
                {quote.number}
              </p>
              {quote.versionLabel ? <p className="text-sm">{quote.versionLabel}</p> : null}
            </div>
          </header>

          <div className="flex flex-col gap-6 p-5 sm:gap-8 sm:p-8">
            {responseNotice ? (
              <p
                role="status"
                data-testid="share-response-notice"
                className="rounded-md bg-surface-2 px-4 py-3 text-base font-medium"
              >
                {responseNotice}
              </p>
            ) : null}

            {paymentSlot}

            <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <dt className="text-fg-subtle">Fecha</dt>
                <dd className="font-medium">{quote.issueDate}</dd>
              </div>
              {quote.validUntil ? (
                <div>
                  <dt className="text-fg-subtle">Válida hasta</dt>
                  <dd className="font-medium">{quote.validUntil}</dd>
                </div>
              ) : null}
            </dl>

            <div className="flex flex-col gap-6 rounded-md bg-[var(--brand-tint)] p-4 sm:flex-row sm:gap-8 sm:p-5">
              {customer ? (
                <Party title="Para" name={customer.name} lines={customer.detailLines} />
              ) : null}
              <Party
                title="Preparada por"
                name={doc.preparedBy.name}
                lines={doc.preparedBy.detailLines}
              />
            </div>

            <section aria-label="Detalle de la cotización">
              {/* Teléfono: una tarjeta por línea. Desde 640 px: la tabla de siempre. */}
              <ul className="flex flex-col gap-3 sm:hidden" data-testid="share-lines-cards">
                {doc.lines.map((line, index) => (
                  <li key={`${index}:${line.name}`} className="rounded-md border border-border p-3">
                    <p className="font-medium break-words">
                      {line.name}
                      {line.exempt ? (
                        <span className="ml-2 rounded-xs bg-surface-2 px-1.5 py-0.5 text-xs">
                          Exento
                        </span>
                      ) : null}
                    </p>
                    {line.description ? (
                      <p className="mt-1 text-sm break-words text-fg-muted">{line.description}</p>
                    ) : null}
                    <p className="mt-2 text-sm text-fg-muted tabular-nums">
                      {line.quantity} {line.unit} × {line.unitPrice}
                      {line.discount !== "—" ? ` · desc. ${line.discount}` : ""}
                    </p>
                    <p className="mt-1 text-right font-semibold tabular-nums">{line.total}</p>
                  </li>
                ))}
              </ul>
              <div className="hidden sm:block">
                <table
                  className="w-full table-fixed border-collapse text-sm"
                  data-testid="share-lines-table"
                >
                  <thead>
                    <tr className={cn("text-left text-xs tracking-[0.08em] uppercase", BRAND_TEXT)}>
                      <th className="w-[38%] border-b border-border-strong py-2 pr-2 font-semibold">
                        Descripción
                      </th>
                      <th className="border-b border-border-strong py-2 pr-2 text-right font-semibold">
                        Cant.
                      </th>
                      <th className="border-b border-border-strong py-2 pl-2 font-semibold">
                        Unidad
                      </th>
                      <th className="border-b border-border-strong py-2 pr-2 text-right font-semibold">
                        Precio unit.
                      </th>
                      <th className="border-b border-border-strong py-2 pr-2 text-right font-semibold">
                        Desc.
                      </th>
                      <th className="border-b border-border-strong py-2 text-right font-semibold">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.lines.map((line, index) => (
                      <tr key={`${index}:${line.name}`} className="align-top">
                        <td className="border-b border-border py-2 pr-2 break-words">
                          <span className="font-medium">{line.name}</span>
                          {line.exempt ? (
                            <span className="ml-2 rounded-xs bg-surface-2 px-1.5 py-0.5 text-xs">
                              Exento
                            </span>
                          ) : null}
                          {line.description ? (
                            <span className="block text-fg-muted">{line.description}</span>
                          ) : null}
                        </td>
                        <td className="border-b border-border py-2 pr-2 text-right tabular-nums">
                          {line.quantity}
                        </td>
                        <td className="border-b border-border py-2 pl-2">{line.unit}</td>
                        <td className="border-b border-border py-2 pr-2 text-right tabular-nums">
                          {line.unitPrice}
                        </td>
                        <td className="border-b border-border py-2 pr-2 text-right tabular-nums">
                          {line.discount}
                        </td>
                        <td className="border-b border-border py-2 text-right font-medium tabular-nums">
                          {line.total}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                {notes.map((note) => (
                  <section key={note.title}>
                    <SectionLabel>{note.title}</SectionLabel>
                    <p className="mt-1 text-sm break-words whitespace-pre-line">{note.text}</p>
                  </section>
                ))}
              </div>
              <div className="w-full sm:w-72">
                <dl className="text-base" data-testid="share-totals">
                  <TotalRow label="Subtotal" value={totals.subtotal} />
                  {totals.globalDiscount ? (
                    <TotalRow label="Descuento global" value={totals.globalDiscount} />
                  ) : null}
                  <TotalRow label="Neto afecto" value={totals.netTaxable} />
                  {totals.exempt ? <TotalRow label="Exento" value={totals.exempt} /> : null}
                  <TotalRow label={totals.taxLabel} value={totals.tax} />
                  <TotalRow label="Total" value={totals.total} strong />
                </dl>
                <p className="mt-2 text-right text-xs text-fg-subtle">Valores en pesos chilenos.</p>
              </div>
            </div>

            {/* «Aceptar» y «Rechazar» (H-031), o la confirmación si ya respondió. */}
            <div data-testid="response-slot">{responseSlot}</div>

            <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
              <a
                href={pdfHref}
                download
                data-testid="share-download-pdf"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-sm border border-border-strong bg-surface px-5 text-base font-semibold text-fg shadow-1 transition-colors hover:bg-surface-2 focus-visible:ring-3 focus-visible:ring-[var(--brand)]/40 focus-visible:outline-none"
              >
                <Download aria-hidden strokeWidth={1.75} className="size-5" />
                Descargar PDF
              </a>
              <p className="text-xs text-fg-subtle">
                Esta cotización no es un documento tributario.
              </p>
            </div>
          </div>
        </article>

        <footer className="mt-6 px-1 text-center text-sm text-fg-muted">
          <p className="font-medium text-fg">{organization.name}</p>
          {organization.detailLines.map((line, index) => (
            <p key={`${index}:${line}`} className="break-words">
              {line}
            </p>
          ))}
        </footer>
      </main>
    </div>
  );
}
