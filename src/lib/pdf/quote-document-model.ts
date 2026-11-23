/**
 * Arma los datos que recibe la plantilla del PDF a partir de lo GUARDADO (H-028). Puro y sin red:
 * lo usan el cargador del servidor y las pruebas.
 *
 * Regla de `cotizaciones-y-calculo.md` §7: el PDF lee lo guardado y NUNCA recalcula. Todos los montos
 * salen de las columnas de `quotes` y `quote_items`; aquí solo se les da formato de texto.
 */
import { INDUSTRIES } from "@/lib/tenant/schemas";
import { formatRut } from "@/lib/rut";
import { formatClp } from "@/lib/money/clp";
import {
  formatPercentBp,
  formatQuantity,
  formatQuoteNumber,
  formatTaxRate,
} from "@/lib/quotes/format";
import type { QuoteItemRow, QuoteRow } from "@/lib/quotes/queries";
import { addDaysIso, isoToDisplay } from "@/lib/quotes/validity";
import { resolvePdfBrand } from "./brand-colors";
import type { PdfLine, PdfLogo, PdfPaperSize, PdfTotals, QuoteDocumentData } from "./types";

export const NO_DISCOUNT_TEXT = "—";

/** Unidades abreviadas para la tabla del PDF (las etiquetas largas de la pantalla no caben). */
const UNIT_SHORT_LABELS: Record<string, string> = {
  service: "servicio",
  hour: "hora",
  km: "km",
  m2: "m²",
  day: "día",
  unit: "unidad",
};

export const unitShortLabel = (unit: string) => UNIT_SHORT_LABELS[unit] ?? unit;

export type DocumentOrganization = {
  name: string;
  rut: string | null;
  industry: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  logo: PdfLogo | null;
};

export type DocumentCustomer = {
  displayName: string;
  rut: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
};

export type QuoteDocumentInput = {
  paper: PdfPaperSize;
  /** `aaaa-mm-dd`, hora de Chile. En la vista previa es hoy; la definitiva se congela al enviar (H-029). */
  today: string;
  quote: QuoteRow;
  items: QuoteItemRow[];
  authorName: string;
  organization: DocumentOrganization;
  customer: DocumentCustomer;
};

const compact = (parts: (string | null | undefined | false)[]): string[] =>
  parts.filter((part): part is string => typeof part === "string" && part.trim() !== "");

const industryLabel = (value: string | null) =>
  INDUSTRIES.find((industry) => industry.value === value)?.label ?? null;

function discountText(item: QuoteItemRow): string {
  if (item.discount_kind === "percent") return `−${formatPercentBp(item.discount_value)}%`;
  if (item.discount_kind === "amount") return `−${formatClp(item.discount_clp)}`;
  return NO_DISCOUNT_TEXT;
}

function lineOf(item: QuoteItemRow): PdfLine {
  return {
    name: item.name,
    description: item.description?.trim() ? item.description.trim() : null,
    exempt: item.tax_treatment === "exempt",
    quantity: formatQuantity(item.quantity_milli),
    unit: unitShortLabel(item.unit),
    unitPrice: formatClp(item.unit_price_clp),
    discount: discountText(item),
    total: formatClp(item.line_total_clp),
  };
}

function totalsOf(quote: QuoteRow): PdfTotals {
  return {
    subtotal: formatClp(quote.subtotal_clp),
    globalDiscount:
      quote.global_discount_clp > 0 ? `−${formatClp(quote.global_discount_clp)}` : null,
    netTaxable: formatClp(quote.net_taxable_clp),
    exempt: quote.net_exempt_clp > 0 ? formatClp(quote.net_exempt_clp) : null,
    taxLabel: `IVA ${formatTaxRate(quote.tax_rate_bp)}`,
    tax: formatClp(quote.tax_clp),
    total: formatClp(quote.total_clp),
  };
}

/** Fecha de vigencia que se imprime y, si es en días, la nota de que cuenta desde el envío. */
export function validityOf(
  quote: Pick<QuoteRow, "valid_until" | "validity_mode" | "validity_days">,
  today: string,
): { validUntil: string | null; validityNote: string | null } {
  if (quote.valid_until) return { validUntil: isoToDisplay(quote.valid_until), validityNote: null };
  if (quote.validity_mode === "days" && quote.validity_days) {
    const unit = quote.validity_days === 1 ? "día" : "días";
    return {
      validUntil: isoToDisplay(addDaysIso(today, quote.validity_days)),
      validityNote: `${quote.validity_days} ${unit} desde su envío`,
    };
  }
  return { validUntil: null, validityNote: null };
}

const PAYMENT_TERMS_TEXT: Record<string, string> = {
  full: "100% al aceptar la cotización.",
  split_50_50: "50% al aceptar y 50% al finalizar el servicio.",
};

/** Los datos de transferencia NO van en el PDF (§6.5): se envían recién al aceptar. */
function paymentTermsText(terms: string | null): string | null {
  const text = terms ? PAYMENT_TERMS_TEXT[terms] : undefined;
  return text ? `${text} Los datos de transferencia se envían al aceptar.` : null;
}

const textOrNull = (value: string | null) => (value && value.trim() !== "" ? value.trim() : null);

export function buildQuoteDocumentData(input: QuoteDocumentInput): QuoteDocumentData {
  const { quote, items, organization, customer } = input;
  const validity = validityOf(quote, input.today);
  return {
    paper: input.paper,
    brand: resolvePdfBrand(organization.primaryColor, organization.secondaryColor),
    organization: {
      name: organization.name,
      logo: organization.logo,
      detailLines: compact([
        compact([
          organization.rut && `RUT ${formatRut(organization.rut)}`,
          industryLabel(organization.industry),
        ]).join(" · "),
        compact([organization.contactEmail, organization.contactPhone]).join(" · "),
      ]),
    },
    quote: {
      number: formatQuoteNumber(quote.number_display, 1),
      versionLabel: quote.version > 1 ? `Versión ${quote.version}` : null,
      issueDate: isoToDisplay(input.today),
      ...validity,
    },
    customer: {
      name: customer.displayName,
      detailLines: compact([
        customer.rut && `RUT ${formatRut(customer.rut)}`,
        customer.address,
        customer.email,
        customer.phone,
      ]),
    },
    preparedBy: {
      name: input.authorName,
      detailLines: compact([
        organization.name,
        compact([organization.contactEmail, organization.contactPhone]).join(" · "),
      ]),
    },
    lines: items.map(lineOf),
    totals: totalsOf(quote),
    observations: textOrNull(quote.observations),
    conditions: textOrNull(quote.conditions),
    exclusions: textOrNull(quote.exclusions),
    footerNote: textOrNull(quote.footer_note),
    paymentTerms: paymentTermsText(quote.payment_terms),
  };
}
