import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FormAlert } from "@/components/ui/form-controls";
import { StatusBadge } from "@/components/ui/status-badge";
import { maskEmail } from "@/lib/customers/mask";
import { getCustomer } from "@/lib/customers/queries";
import { formatDate } from "@/lib/format-date";
import { listQuotableCatalogItems } from "@/lib/quotes/catalog-source";
import { lineFromSaved, type EditorState } from "@/lib/quotes/editor-model";
import {
  EDITABLE_STATUSES,
  formatPercentBp,
  formatQuoteNumber,
  toBadgeStatus,
} from "@/lib/quotes/format";
import { getQuote } from "@/lib/quotes/queries";
import { editorValidity } from "@/lib/quotes/editor-model";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { QuoteEditor } from "./quote-editor";
import { QuoteReadOnly } from "./quote-read-only";

export const metadata: Metadata = { title: "Cotización · Cotiza Prime" };

const DEFAULT_VALIDITY_DAYS_FALLBACK = 15;
const WRITER_ROLES = ["owner", "admin", "sales"];

export default async function QuotePage({
  params,
}: PageProps<"/o/[tenantId]/cotizaciones/[quoteId]">) {
  const { tenantId, quoteId } = await params;
  const active = await requireActiveTenant(tenantId);
  const detail = await getQuote(active, quoteId);
  if (detail === null) notFound();
  const { quote, items, authorName, inactiveCatalogIds } = detail;

  const customer = await getCustomer(active, quote.customer_id);
  const customerName =
    customer === null || customer === "unreadable" ? "Cliente" : customer.displayName;
  const customerEmail =
    customer !== null && customer !== "unreadable" && customer.email
      ? maskEmail(customer.email)
      : null;

  const isAuthor = quote.created_by === active.userId;
  const statusAllowsEdit = EDITABLE_STATUSES.includes(quote.status);
  const editable = WRITER_ROLES.includes(active.role) && isAuthor && statusAllowsEdit;
  const listPath = tenantPath(active.tenantId, "cotizaciones");

  let readOnlyReason: string | null = null;
  if (!editable) {
    if (!statusAllowsEdit) readOnlyReason = "Esta cotización ya no se puede editar.";
    else if (!WRITER_ROLES.includes(active.role)) {
      readOnlyReason = "Tu rol solo permite ver las cotizaciones.";
    } else readOnlyReason = `Solo ${authorName} puede editar este borrador. Tú puedes verlo.`;
  }

  // Cotizaciones sin vigencia guardada: parten con la de la organización.
  let organizationDays = DEFAULT_VALIDITY_DAYS_FALLBACK;
  if (quote.validity_mode === null) {
    const { data: tenantRow } = await active.supabase
      .from("tenants")
      .select("default_validity_days")
      .eq("tenant_id", active.tenantId)
      .maybeSingle();
    organizationDays = (tenantRow?.default_validity_days as number | undefined) ?? organizationDays;
  }

  const inactive = new Set(inactiveCatalogIds);
  const initialState: EditorState = {
    customerId: quote.customer_id,
    lines: items.map((item) =>
      lineFromSaved(item, item.catalog_item_id !== null && inactive.has(item.catalog_item_id)),
    ),
    globalDiscountKind: quote.global_discount_kind,
    globalDiscount:
      quote.global_discount_kind === "none"
        ? ""
        : quote.global_discount_kind === "percent"
          ? formatPercentBp(quote.global_discount_value)
          : String(quote.global_discount_value),
    ...editorValidity(quote, organizationDays),
    observations: quote.observations ?? "",
    conditions: quote.conditions ?? "",
  };
  const initialCatalog = editable ? await listQuotableCatalogItems(active, "") : [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Link
          href={listPath}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-fg-muted hover:text-fg"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Cotizaciones
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl md:text-2xl" data-testid="quote-number">
            {formatQuoteNumber(quote.number_display, quote.version)}
          </h1>
          <StatusBadge status={toBadgeStatus(quote.status)} />
        </div>
        <p className="text-fg-muted">
          Para <strong className="text-fg">{customerName}</strong>
          {customerEmail ? <> · {customerEmail}</> : null} · Creada por {authorName} el{" "}
          {formatDate(quote.created_at)}
        </p>
      </header>

      {readOnlyReason ? <FormAlert tone="warning">{readOnlyReason}</FormAlert> : null}

      {editable ? (
        <QuoteEditor
          tenantId={active.tenantId}
          quoteId={quote.id}
          initialState={initialState}
          initialRevision={quote.revision}
          taxRateBp={quote.tax_rate_bp}
          savedValidUntil={quote.valid_until}
          initialCatalog={initialCatalog}
        />
      ) : (
        <QuoteReadOnly
          tenantId={active.tenantId}
          quote={quote}
          items={items}
          inactiveCatalogIds={inactiveCatalogIds}
        />
      )}
    </div>
  );
}
