/**
 * Datos cerrados que recibe una plantilla de PDF (PROYECTO.md §13.7: plantillas cerradas con
 * variables; nadie escribe HTML ni código libre). Todo viene ya formateado como texto: la plantilla
 * no calcula ni decide nada, solo dibuja lo que se le entrega.
 */

export const PDF_PAPER_SIZES = ["letter", "a4"] as const;
export type PdfPaperSize = (typeof PDF_PAPER_SIZES)[number];

export type PdfLogo = {
  /** Solo PNG o JPG: un SVG se convierte a PNG antes de llegar aquí. */
  format: "png" | "jpg";
  data: Buffer;
};

export type PdfBrand = {
  /** Franjas y fondos (color tal cual lo eligió la organización). */
  primary: string;
  secondary: string;
  /** Color de los textos de marca: el principal, oscurecido si no se lee sobre blanco (4,5:1). */
  primaryText: string;
  /** Texto sobre una banda del color principal: blanco u oscuro, el que mejor se lea. */
  onPrimary: string;
  /** Fondo muy suave del bloque "Para". */
  primaryTint: string;
};

export type PdfLine = {
  name: string;
  description: string | null;
  exempt: boolean;
  quantity: string;
  unit: string;
  unitPrice: string;
  /** `—` si no hay descuento. */
  discount: string;
  total: string;
};

export type PdfTotals = {
  subtotal: string;
  /** Solo si hay descuento global. */
  globalDiscount: string | null;
  netTaxable: string;
  /** Solo si hay montos exentos. */
  exempt: string | null;
  /** `IVA 19%`: la tasa sale de la cotización, no de una constante. */
  taxLabel: string;
  tax: string;
  total: string;
};

export type QuoteDocumentData = {
  paper: PdfPaperSize;
  brand: PdfBrand;
  organization: {
    name: string;
    logo: PdfLogo | null;
    /** Líneas ya armadas: `RUT … · Giro`, contacto. */
    detailLines: string[];
  };
  quote: {
    /** `COT-2026-0043` */
    number: string;
    /** `Versión 2`, o `null` en la primera. */
    versionLabel: string | null;
    issueDate: string;
    /** Fecha de vigencia (real o estimada); `null` si no hay vigencia definida. */
    validUntil: string | null;
    /** `15 días desde su envío` cuando la vigencia es en días y todavía no se envía. */
    validityNote: string | null;
  };
  customer: {
    name: string;
    detailLines: string[];
  };
  preparedBy: { name: string; detailLines: string[] };
  lines: PdfLine[];
  totals: PdfTotals;
  observations: string | null;
  conditions: string | null;
  /** H-048b: lo que NO incluye la cotización. Texto simple, opcional. */
  exclusions: string | null;
  /** H-048b: notas al final del documento (no el pie fijo de cada página). Texto simple, opcional. */
  footerNote: string | null;
  paymentTerms: string | null;
};
