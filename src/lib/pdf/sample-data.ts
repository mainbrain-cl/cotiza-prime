/**
 * Cotización de ejemplo (todo ficticio) para probar la plantilla sin base de datos. Solo para pruebas
 * y para generar el PDF de muestra: no se importa desde la aplicación.
 *
 * Los montos nunca se escriben a mano: salen de `calculateQuote`, el mismo cálculo de la aplicación,
 * así el ejemplo siempre cuadra (líneas, subtotal, descuento, IVA y total).
 */
import { calculateQuote, type QuoteTotals } from "@/lib/quotes/calc";
import type { QuoteItemRow, QuoteRow } from "@/lib/quotes/queries";
import { buildQuoteDocumentData, type QuoteDocumentInput } from "./quote-document-model";
import type { PdfPaperSize, QuoteDocumentData } from "./types";

const SAMPLE_GLOBAL_DISCOUNT_CLP = 10_000;
const SAMPLE_TAX_RATE_BP = 1900;
const DEFAULT_LINE_COUNT = 4;

/** Totales de una lista de líneas de ejemplo, con el cálculo de la aplicación. */
export function sampleTotals(items: QuoteItemRow[]): QuoteTotals {
  const result = calculateQuote({
    lines: items.map((item) => ({
      quantityMilli: item.quantity_milli,
      unitPriceClp: item.unit_price_clp,
      taxTreatment: item.tax_treatment,
      discount:
        item.discount_kind === "percent"
          ? { kind: "percent", bp: item.discount_value }
          : item.discount_kind === "amount"
            ? { kind: "amount", clp: item.discount_value }
            : { kind: "none" },
    })),
    globalDiscount: { kind: "amount", clp: SAMPLE_GLOBAL_DISCOUNT_CLP },
    taxRateBp: SAMPLE_TAX_RATE_BP,
  });
  if (!result.ok) throw new Error("Los datos de ejemplo no se pueden calcular.");
  return result.totals;
}

/** Cotización de ejemplo: sus totales salen del cálculo de las líneas dadas (por defecto, las 4 de ejemplo). */
export function sampleQuoteRow(
  overrides: Partial<QuoteRow> = {},
  items: QuoteItemRow[] = sampleItems(DEFAULT_LINE_COUNT),
): QuoteRow {
  const totals = sampleTotals(items);
  return {
    id: "00000000-0000-4000-8000-000000000001",
    number_display: "COT-2026-0043",
    version: 1,
    status: "draft",
    revision: 1,
    customer_id: "00000000-0000-4000-8000-000000000002",
    created_by: "00000000-0000-4000-8000-000000000003",
    created_at: "2026-10-05T12:00:00Z",
    updated_at: "2026-10-05T12:00:00Z",
    tax_rate_bp: SAMPLE_TAX_RATE_BP,
    global_discount_kind: "amount",
    global_discount_value: SAMPLE_GLOBAL_DISCOUNT_CLP,
    subtotal_taxable_clp: totals.subtotalTaxableClp,
    subtotal_exempt_clp: totals.subtotalExemptClp,
    subtotal_clp: totals.subtotalClp,
    line_discounts_clp: totals.lineDiscountsClp,
    global_discount_clp: totals.globalDiscountClp,
    global_discount_taxable_clp: totals.globalDiscountTaxableClp,
    global_discount_exempt_clp: totals.globalDiscountExemptClp,
    net_taxable_clp: totals.netTaxableClp,
    net_exempt_clp: totals.netExemptClp,
    tax_clp: totals.taxClp,
    total_clp: totals.totalClp,
    validity_mode: "date",
    validity_days: null,
    valid_until: "2026-10-20",
    observations: "Carga y descarga a pie de camión.\nNo incluye embalaje.",
    conditions: "Valores válidos para una visita en día hábil.",
    exclusions: null,
    footer_note: null,
    payment_terms: null,
    ...overrides,
  };
}

export function sampleItem(index: number, overrides: Partial<QuoteItemRow> = {}): QuoteItemRow {
  return {
    id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
    position: index,
    catalog_item_id: null,
    catalog_unit_price_clp: null,
    name: `Flete Santiago – Talca, tramo ${index + 1}`,
    description: `Detalle ${index + 1}`,
    unit: "service",
    tax_treatment: "taxable",
    quantity_milli: 1000,
    unit_price_clp: 100_000,
    discount_kind: "none",
    discount_value: 0,
    gross_clp: 100_000,
    discount_clp: 0,
    line_total_clp: 100_000,
    ...overrides,
  };
}

/** Líneas de ejemplo con bruto, descuento y total calculados (nada a mano). */
export function sampleItems(lineCount: number): QuoteItemRow[] {
  const items = Array.from({ length: lineCount }, (_, index) => sampleItem(index));
  if (lineCount >= 3) {
    items[1] = sampleItem(1, {
      name: "Ayudante de carga y descarga",
      description: null,
      unit: "day",
      quantity_milli: 2000,
      unit_price_clp: 45_000,
    });
    items[2] = sampleItem(2, {
      name: "Seguro de carga",
      description: "Cobertura hasta $25.000.000",
      tax_treatment: "exempt",
      unit_price_clp: 38_000,
    });
  }
  if (lineCount >= 4) {
    items[3] = sampleItem(3, {
      name: "Retorno vacío",
      description: null,
      unit_price_clp: 210_000,
      discount_kind: "percent",
      discount_value: 1000,
    });
  }
  const { lines } = sampleTotals(items);
  return items.map((item, index) => ({
    ...item,
    gross_clp: lines[index].grossClp,
    discount_clp: lines[index].discountClp,
    line_total_clp: lines[index].totalClp,
  }));
}

export function sampleInput(
  overrides: Partial<QuoteDocumentInput> & { lineCount?: number } = {},
): QuoteDocumentInput {
  const { lineCount = DEFAULT_LINE_COUNT, ...rest } = overrides;
  const items = sampleItems(lineCount);
  return {
    paper: "letter",
    today: "2026-10-05",
    quote: sampleQuoteRow({}, items),
    items,
    authorName: "Juan Pérez",
    organization: {
      name: "Transportes Andes SpA",
      rut: "76482913-5",
      industry: "logistics",
      contactEmail: "ventas@transportesandes.cl",
      contactPhone: "+56 2 2945 3100",
      primaryColor: "#0e4c7a",
      secondaryColor: "#e8a33d",
      logo: null,
    },
    customer: {
      displayName: "Distribuidora Maule Ltda.",
      rut: "77120554-K",
      email: "cmunoz@distmaule.cl",
      phone: "+56 9 1234 5678",
      address: "Camino a San Clemente km 4, Talca",
    },
    ...rest,
  };
}

export function sampleDocument(
  overrides: Partial<QuoteDocumentInput> & { lineCount?: number } = {},
  paper: PdfPaperSize = "letter",
): QuoteDocumentData {
  return buildQuoteDocumentData({ ...sampleInput(overrides), paper });
}
