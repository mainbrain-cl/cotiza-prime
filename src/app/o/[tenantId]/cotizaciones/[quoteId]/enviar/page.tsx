import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-controls";
import { loadCurrentApprovalRule } from "@/lib/approvals/queries";
import { priceRebateOfLines } from "@/lib/approvals/rule";
import {
  APPROVAL_RULE_UNAVAILABLE_MESSAGE,
  approvalBlockMessage,
} from "@/lib/approvals/send-block";
import { maskEmail } from "@/lib/customers/mask";
import { getCustomer } from "@/lib/customers/queries";
import { resolvePdfBrand } from "@/lib/pdf/brand-colors";
import { formatQuoteNumber } from "@/lib/quotes/format";
import { getQuote } from "@/lib/quotes/queries";
import { defaultEmailBody, defaultEmailSubject } from "@/lib/quotes/send/content";
import { loadSendContext } from "@/lib/quotes/send/context";
import { pagePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { cn } from "@/lib/utils";
import { SendQuoteForm } from "./send-quote-form";

export const metadata: Metadata = { title: "Enviar cotización · Cotiza Prime" };
// Enviar arma el PDF en el servidor (hasta decenas de segundos con muchas líneas). Next solo lee este
// valor escrito a mano: `src/lib/quotes/send/dispatch.test.ts` exige que coincida con
// SEND_PAGE_MAX_DURATION_SECONDS y que, más un margen, quede bajo el candado de envío de la base.
export const maxDuration = 60;

export default async function SendQuotePage({
  params,
}: PageProps<"/o/[tenantId]/cotizaciones/[quoteId]/enviar">) {
  const { tenantId, quoteId } = await params;
  const active = await requireActiveTenant(tenantId);
  // Antes de leer el paquete: quien no puede enviar cotizaciones no ve nada de esta pantalla.
  const denied = pagePermission(active, "quote.send");
  if (denied) return denied;
  const detail = await getQuote(active, quoteId);
  if (detail === null) notFound();
  const { quote, items, authorName } = detail;
  const quotePath = tenantPath(active.tenantId, `cotizaciones/${quote.id}`);

  // Ya enviada (o en otro estado): no hay nada que redactar; se vuelve a la cotización.
  if (quote.status !== "draft") redirect(quotePath);

  const customer = await getCustomer(active, quote.customer_id);
  const context = await loadSendContext(active);
  // La regla de aprobación de la organización (H-040b): la lee cualquier miembro. Si no se puede leer, no se deja enviar.
  const approvalRule = await loadCurrentApprovalRule(active);
  const customerName =
    customer === null || customer === "unreadable" ? "Cliente" : customer.displayName;
  const customerEmail =
    customer !== null && customer !== "unreadable" ? (customer.email ?? null) : null;

  // Lo que impide enviar, dicho con claridad (la acción de enviar lo vuelve a verificar).
  const approvalBlock =
    approvalRule.status === "ok"
      ? approvalBlockMessage(approvalRule.current.rule, {
          subtotalClp: quote.subtotal_clp,
          lineDiscountsClp: quote.line_discounts_clp,
          globalDiscountClp: quote.global_discount_clp,
          totalClp: quote.total_clp,
          // Bajar el precio de un servicio del catálogo también cuenta como descuento (decisión de Aarón, 2026-11-11).
          priceRebateClp: priceRebateOfLines(
            items.map((item) => ({
              quantityMilli: item.quantity_milli,
              grossClp: item.gross_clp,
              catalogUnitPriceClp: item.catalog_unit_price_clp,
            })),
          ),
        })
      : null;
  let blocker: string | null = null;
  if (quote.created_by !== active.userId) {
    blocker = `Solo ${authorName} puede enviar este borrador. Tú puedes verlo.`;
  } else if (items.length === 0) {
    blocker = "Agrega al menos una línea a la cotización antes de enviarla.";
  } else if (customer === "unreadable") {
    blocker = "No pudimos leer los datos del cliente. Revisa su ficha.";
  } else if (!customerEmail) {
    blocker =
      "Este cliente no tiene correo. Agrégalo en su ficha para poder enviarle la cotización.";
  } else if (approvalRule.status !== "ok") {
    blocker = APPROVAL_RULE_UNAVAILABLE_MESSAGE;
  } else if (approvalBlock) {
    blocker = approvalBlock;
  } else if (context === null) {
    blocker = "No pudimos cargar los datos de tu organización. Intenta de nuevo en unos minutos.";
  }

  const brand = context ? resolvePdfBrand(context.brandPrimary, context.brandSecondary) : null;
  const number = formatQuoteNumber(quote.number_display, quote.version);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Link
          href={quotePath}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-fg-muted hover:text-fg"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Volver a la cotización
        </Link>
        <h1 className="text-xl md:text-2xl">
          Enviar <span className="font-mono">{number}</span>
        </h1>
        <p className="text-fg-muted">
          Se envía lo que tienes guardado en la cotización. Revisa el correo y el PDF antes de
          enviar.
        </p>
      </header>

      {blocker ? (
        <div className="flex flex-col gap-3" data-testid="send-blocker">
          <FormAlert tone="warning">{blocker}</FormAlert>
          <div className="flex flex-wrap gap-2">
            <Link href={quotePath} className={cn(buttonVariants({ variant: "secondary" }))}>
              Volver a la cotización
            </Link>
            {customer !== null && customer !== "unreadable" && !customerEmail ? (
              <Link
                href={tenantPath(active.tenantId, `clientes/${quote.customer_id}/editar`)}
                className={cn(buttonVariants({ variant: "secondary" }))}
              >
                Agregar el correo del cliente
              </Link>
            ) : null}
          </div>
        </div>
      ) : context && brand && customerEmail ? (
        <SendQuoteForm
          tenantId={active.tenantId}
          quoteId={quote.id}
          expectedRevision={quote.revision}
          quotePath={quotePath}
          initialSubject={defaultEmailSubject(quote.number_display, context.organizationName)}
          initialBody={defaultEmailBody({
            customerName,
            authorName,
            organizationName: context.organizationName,
          })}
          organizationName={context.organizationName}
          brandPrimary={brand.primary}
          brandOnPrimary={brand.onPrimary}
          brandText={brand.primaryText}
          customerName={customerName}
          maskedRecipient={maskEmail(customerEmail)}
          replyTo={context.contactEmail ?? (active.user.email || null)}
          pdfSrc={`/api/v1/tenants/${active.tenantId}/quotes/${quote.id}/pdf?size=letter`}
        />
      ) : null}
    </div>
  );
}
