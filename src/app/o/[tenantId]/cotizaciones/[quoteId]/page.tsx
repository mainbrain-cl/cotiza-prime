import { ChevronLeft, Pencil, Send } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-controls";
import { DeliveryBadge } from "@/components/ui/delivery-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { maskEmail } from "@/lib/customers/mask";
import { getCustomer } from "@/lib/customers/queries";
import { SourceRequestPanelView } from "@/components/intake/source-request-panel";
import { formatDate } from "@/lib/format-date";
import { loadQuoteSourceRequestId, loadSourceRequestPanel } from "@/lib/intake/convert-queries";
import {
  listNotAllowedCatalogIds,
  listQuotableCatalogItems,
  loadMyCatalogScope,
} from "@/lib/quotes/catalog-source";
import { lineFromSaved, type EditorState } from "@/lib/quotes/editor-model";
import {
  EDITABLE_STATUSES,
  formatPercentBp,
  formatQuoteNumber,
  toBadgeStatus,
} from "@/lib/quotes/format";
import { getQuoteDelivery } from "@/lib/quotes/delivery";
import { needsAttention } from "@/lib/quotes/delivery-model";
import { canRevokeLinks } from "@/lib/quotes/link-rules";
import { hasActiveShareLink } from "@/lib/quotes/links";
import { loadMaxDiscountBp } from "@/lib/quotes/line-rules-queries";
import { loadSnippets } from "@/lib/snippets/queries";
import { quoteFieldSnippets } from "@/lib/snippets/quote-fields";
import { getQuote, isActiveMember } from "@/lib/quotes/queries";
import { readOnlyReason } from "@/lib/quotes/read-only-reason";
import { getQuoteResponse } from "@/lib/quotes/response";
import { listQuoteTimeline } from "@/lib/quotes/timeline";
import { editorValidity } from "@/lib/quotes/editor-model";
import { can, canEver } from "@/lib/permissions/matrix";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { cn } from "@/lib/utils";
import { CustomerResponse } from "./customer-response";
import { loadQuoteMilestones } from "@/lib/payments/queries";
import { QuoteEditor } from "./quote-editor";
import { QuotePayments } from "./quote-payments";
import { QuoteReadOnly } from "./quote-read-only";
import { QuoteTimeline } from "./quote-timeline";
import { ResendButton } from "./resend-button";
import { RevokeLinkButton } from "./revoke-link-button";

export const metadata: Metadata = { title: "Cotización · Cotiza Prime" };

const DEFAULT_VALIDITY_DAYS_FALLBACK = 15;
const RESENDABLE_STATUSES = ["sent", "viewed"];
const PAYMENT_STATUSES = [
  "accepted",
  "pending_payment",
  "pending_deposit",
  "deposit_paid",
  "pending_balance",
  "paid",
];

export default async function QuotePage({
  params,
}: PageProps<"/o/[tenantId]/cotizaciones/[quoteId]">) {
  const { tenantId, quoteId } = await params;
  const active = await requireActiveTenant(tenantId);
  const detail = await getQuote(active, quoteId);
  if (detail === null) notFound();
  const { quote, items, authorName, inactiveCatalogIds, lockedCatalogIds, catalogPricesToday } =
    detail;

  const customer = await getCustomer(active, quote.customer_id);
  const customerName =
    customer === null || customer === "unreadable" ? "Cliente" : customer.displayName;
  const customerEmail =
    customer !== null && customer !== "unreadable" && customer.email
      ? maskEmail(customer.email)
      : null;

  const isAuthor = quote.created_by === active.userId;
  const statusAllowsEdit = EDITABLE_STATUSES.includes(quote.status);
  const editable = can(active.role, "quote.edit", { isOwn: isAuthor }) && statusAllowsEdit;
  const listPath = tenantPath(active.tenantId, "cotizaciones");
  const sendPath = tenantPath(active.tenantId, `cotizaciones/${quote.id}/enviar`);
  // Reenvía el autor, el Dueño o un Administrador (la base lo vuelve a verificar).
  const canResend =
    RESENDABLE_STATUSES.includes(quote.status) &&
    can(active.role, "quote.resend", { isOwn: isAuthor });
  const timeline = await listQuoteTimeline(active, quote.id);
  // El cobro (H-054 a H-057): los hitos existen desde que el cliente aceptó una cotización con condición de pago.
  const milestones = PAYMENT_STATUSES.includes(quote.status)
    ? await loadQuoteMilestones(active, quote.id)
    : [];
  const customerResponse = await getQuoteResponse(active, quote.id);
  // Entrega del último correo (H-033) y enlace del cliente (H-035): solo si la cotización ya salió.
  const delivery = quote.status === "draft" ? null : await getQuoteDelivery(active, quote.id);
  const bounced = needsAttention(delivery);
  const revocable = canRevokeLinks({
    role: active.role,
    isAuthor,
    status: quote.status,
  });
  const linkIsActive = revocable ? await hasActiveShareLink(active, quote.id) : true;
  const canRevoke = revocable && linkIsActive;
  const linkRevoked = revocable && !linkIsActive;
  const customerEditPath = tenantPath(active.tenantId, `clientes/${quote.customer_id}/editar`);

  // Solo hace falta saber si el autor sigue en el equipo cuando el borrador es de otra persona.
  const roleCanEdit = canEver(active.role, "quote.edit");
  const authorIsActive =
    editable || isAuthor || !statusAllowsEdit || !roleCanEdit
      ? true
      : await isActiveMember(active, quote.created_by);
  const readOnlyText = readOnlyReason({
    editable,
    statusAllowsEdit,
    roleCanEdit,
    authorName,
    authorIsActive,
  });

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
  const locked = new Set(lockedCatalogIds);
  const initialState: EditorState = {
    customerId: quote.customer_id,
    lines: items.map((item) =>
      lineFromSaved(
        item,
        item.catalog_item_id !== null && inactive.has(item.catalog_item_id),
        item.catalog_item_id !== null && locked.has(item.catalog_item_id),
        item.catalog_item_id === null ? null : (catalogPricesToday[item.catalog_item_id] ?? null),
      ),
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
    exclusions: quote.exclusions ?? "",
    footerNote: quote.footer_note ?? "",
  };
  // Las reglas de precio y descuento (H-041): el descuento máximo de la organización y si esta persona se salta el candado. Quien
  // se las salta (Dueño, Administrador) no necesita el tope: no se lee. Si no se puede leer, la pantalla no marca ningún máximo y
  // lo dice (`maxDiscountUnknown`); el servidor y la base rechazan igual lo que no corresponda al guardar.
  const canOverride = can(active.role, "catalog.price_lock.override");
  // Las tres lecturas no dependen entre sí: van juntas. `catalogScope` (H-042): los servicios que esta persona puede cotizar; si tiene
  // lista, el editor lo avisa.
  const [initialCatalog, catalogScope, maxDiscount] = await Promise.all([
    editable ? listQuotableCatalogItems(active, "") : Promise.resolve([]),
    editable ? loadMyCatalogScope(active) : Promise.resolve(null),
    editable && !canOverride ? loadMaxDiscountBp(active) : Promise.resolve(null),
  ]);
  // Las líneas que la cotización ya tenía de un servicio que salió de su lista se conservan, con un aviso junto a la línea (la base solo
  // revisa las líneas NUEVAS).
  const activeLineCatalogIds = items.flatMap((item) =>
    item.catalog_item_id !== null && !inactive.has(item.catalog_item_id)
      ? [item.catalog_item_id]
      : [],
  );
  const notAllowedCatalogIds =
    catalogScope?.limited && activeLineCatalogIds.length > 0
      ? ((await listNotAllowedCatalogIds(active, activeLineCatalogIds)) ?? [])
      : [];
  const rules = {
    maxDiscountBp: maxDiscount?.maxDiscountBp ?? null,
    canOverride,
    maxDiscountUnknown: editable && !canOverride && maxDiscount === null,
  };
  // Los textos guardados que ofrece «Insertar texto guardado» (H-048b): los lee cualquier miembro, con su propio pase. Solo se leen si se
  // puede editar. Quien puede administrarlos ve además el enlace a Configuración.
  const snippetList = editable ? await loadSnippets(active) : null;
  const snippets = quoteFieldSnippets(snippetList?.ok ? snippetList.groups : null);
  const manageSnippetsHref = can(active.role, "settings.manage")
    ? tenantPath(active.tenantId, "configuracion/textos")
    : null;
  // «Solicitud original» (H-090): solo si la cotización nació de una solicitud del formulario público.
  const sourcePanel = await loadSourceRequestPanel(
    active,
    await loadQuoteSourceRequestId(active, quote.id),
    items.flatMap((item) => (item.catalog_item_id ? [item.catalog_item_id] : [])),
    editable,
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Link
          href={listPath}
          className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold text-fg-muted hover:text-fg"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Cotizaciones
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl md:text-2xl" data-testid="quote-number">
            {formatQuoteNumber(quote.number_display, quote.version)}
          </h1>
          <StatusBadge status={toBadgeStatus(quote.status)} />
          {delivery ? <DeliveryBadge status={delivery.status} /> : null}
          {editable && quote.status === "draft" ? (
            <Link
              href={sendPath}
              data-testid="go-send"
              className={cn(buttonVariants({ variant: "primary" }), "md:ml-auto")}
            >
              <Send aria-hidden />
              Enviar al cliente
            </Link>
          ) : null}
          {(canResend && !bounced) || canRevoke ? (
            <div className="flex flex-wrap items-start gap-2 md:ml-auto">
              {canResend && !bounced ? (
                <ResendButton tenantId={active.tenantId} quoteId={quote.id} />
              ) : null}
              {canRevoke ? (
                <RevokeLinkButton tenantId={active.tenantId} quoteId={quote.id} />
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="text-fg-muted">
          Para <strong className="text-fg">{customerName}</strong>
          {customerEmail ? <> · {customerEmail}</> : null} · Creada por {authorName} el{" "}
          {formatDate(quote.created_at)}
        </p>
        {bounced ? (
          <div
            role="alert"
            data-testid="bounce-alert"
            className="flex flex-col gap-3 rounded-md border border-danger bg-danger-soft p-4 text-danger"
          >
            <p className="font-semibold">
              {delivery?.status === "complained"
                ? "El cliente marcó tu correo como spam."
                : "El correo no llegó: la dirección del cliente rebotó."}
            </p>
            <p className="text-sm">
              Revisa que el correo del cliente esté bien escrito, corrígelo en su ficha y vuelve a
              reenviar la cotización. El reenvío usa el correo que tenga la ficha en ese momento.
            </p>
            <div className="flex flex-wrap items-start gap-2">
              <Link
                href={customerEditPath}
                data-testid="fix-customer-email"
                className={buttonVariants({ variant: "secondary" })}
              >
                <Pencil aria-hidden />
                Corregir correo del cliente
              </Link>
              {canResend ? <ResendButton tenantId={active.tenantId} quoteId={quote.id} /> : null}
            </div>
          </div>
        ) : null}
        {linkRevoked ? (
          <FormAlert tone="warning">
            <span data-testid="link-revoked-note">
              Revocaste el enlace del cliente: ya no puede abrir esta cotización. Para volver a
              ofrecérsela, reenvíala y le llegará un enlace nuevo.
            </span>
          </FormAlert>
        ) : null}
      </header>

      <CustomerResponse response={customerResponse} />

      {milestones.length > 0 ? (
        <QuotePayments
          tenantId={active.tenantId}
          quoteId={quote.id}
          rows={milestones}
          canConfirm={can(active.role, "payment.confirm")}
          canRequestSecond={can(active.role, "payment.second.request", { isOwn: isAuthor })}
        />
      ) : null}

      {readOnlyText ? <FormAlert tone="warning">{readOnlyText}</FormAlert> : null}

      {sourcePanel ? (
        <SourceRequestPanelView
          tenantId={active.tenantId}
          panel={sourcePanel}
          catalogLimited={catalogScope?.limited === true}
        />
      ) : null}

      {editable ? (
        <QuoteEditor
          tenantId={active.tenantId}
          quoteId={quote.id}
          initialState={initialState}
          initialRevision={quote.revision}
          taxRateBp={quote.tax_rate_bp}
          savedValidUntil={quote.valid_until}
          initialCatalog={initialCatalog}
          requestSeedLines={sourcePanel?.seedLines ?? []}
          rules={rules}
          snippets={snippets}
          manageSnippetsHref={manageSnippetsHref}
          catalogScope={catalogScope}
          notAllowedCatalogIds={notAllowedCatalogIds}
        />
      ) : (
        <QuoteReadOnly
          tenantId={active.tenantId}
          quote={quote}
          items={items}
          inactiveCatalogIds={inactiveCatalogIds}
        />
      )}

      <QuoteTimeline entries={timeline} />
    </div>
  );
}
