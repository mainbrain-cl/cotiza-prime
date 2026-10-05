/**
 * Cotización de ejemplo (todo ficticio) para probar la plantilla sin base de datos. Solo para pruebas
 * y para generar el PDF de muestra: no se importa desde la aplicación.
 */
import type { QuoteItemRow, QuoteRow } from "@/lib/quotes/queries";
import { buildQuoteDocumentData, type QuoteDocumentInput } from "./quote-document-model";
import type { PdfPaperSize, QuoteDocumentData } from "./types";

export function sampleQuoteRow(overrides: Partial<QuoteRow> = {}): QuoteRow {
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
    tax_rate_bp: 1900,
    global_discount_kind: "amount",
    global_discount_value: 10_000,
    subtotal_taxable_clp: 0,
    subtotal_exempt_clp: 0,
    subtotal_clp: 1_000_000,
    line_discounts_clp: 0,
    global_discount_clp: 10_000,
    global_discount_taxable_clp: 10_000,
    global_discount_exempt_clp: 0,
    net_taxable_clp: 952_000,
    net_exempt_clp: 38_000,
    tax_clp: 180_880,
    total_clp: 1_170_880,
    validity_mode: "date",
    validity_days: null,
    valid_until: "2026-10-20",
    observations: "Carga y descarga a pie de camión.\nNo incluye embalaje.",
    conditions: "Valores válidos para una visita en día hábil.",
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

export function sampleInput(
  overrides: Partial<QuoteDocumentInput> & { lineCount?: number } = {},
): QuoteDocumentInput {
  const { lineCount = 4, ...rest } = overrides;
  const items = Array.from({ length: lineCount }, (_, index) => sampleItem(index));
  if (lineCount >= 3) {
    items[1] = sampleItem(1, {
      name: "Ayudante de carga y descarga",
      description: null,
      unit: "day",
      quantity_milli: 2000,
      unit_price_clp: 45_000,
      gross_clp: 90_000,
      line_total_clp: 90_000,
    });
    items[2] = sampleItem(2, {
      name: "Seguro de carga",
      description: "Cobertura hasta $25.000.000",
      tax_treatment: "exempt",
      unit_price_clp: 38_000,
      gross_clp: 38_000,
      line_total_clp: 38_000,
    });
  }
  if (lineCount >= 4) {
    items[3] = sampleItem(3, {
      name: "Retorno vacío",
      description: null,
      unit_price_clp: 210_000,
      gross_clp: 210_000,
      discount_kind: "percent",
      discount_value: 1000,
      discount_clp: 21_000,
      line_total_clp: 189_000,
    });
  }
  return {
    paper: "letter",
    today: "2026-10-05",
    quote: sampleQuoteRow(),
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
