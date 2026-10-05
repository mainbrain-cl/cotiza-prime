/**
 * Cálculo de una cotización en pesos enteros (cotizaciones-y-calculo.md §3).
 *
 * Función pura: sin base de datos, sin red, sin secretos. Por dentro usa `bigint`; por fuera
 * devuelve enteros seguros. La base de datos tiene una copia (`app.quote_calc_v1`) que comprueba
 * cada guardado: si cambias una regla aquí, cámbiala allá y sube `QUOTE_CALC_VERSION`.
 *
 * Redondeo: medio peso hacia arriba (`roundHalfUpDiv`). Solo redondean 4 lugares:
 *   ① bruto de línea, ② descuento en porcentaje (de línea y global), ③ reparto del descuento
 *   global entre afecto y exento, ④ IVA. Todo lo demás son sumas y restas de enteros.
 * Un descuento que queda justo en medio peso sube a favor del cliente (máximo $0,5 por línea);
 * el IVA se redondea al peso más cercano. El IVA se calcula una sola vez, sobre el neto afecto.
 */

import { MAX_CLP } from "@/lib/money/clp";
import { roundHalfUpDiv } from "@/lib/money/rounding";

export const QUOTE_CALC_VERSION = "quote-calc-v1";

export const QUOTE_MAX_LINES = 200;
/** 0,001 (una milésima). La cantidad 0 no se acepta. */
export const QUANTITY_MIN_MILLI = 1;
/** 1.000.000 unidades, en milésimas. */
export const QUANTITY_MAX_MILLI = 1_000_000_000;
export const UNIT_PRICE_MAX_CLP = MAX_CLP;
export const LINE_GROSS_MAX_CLP = MAX_CLP;
export const QUOTE_TOTAL_MAX_CLP = MAX_CLP;
/** 100% en puntos base. */
export const PERCENT_MAX_BP = 10_000;
export const TAX_RATE_MAX_BP = 10_000;

const ZERO = BigInt(0);
const MILLI_PER_UNIT = BigInt(1000);
const BP_DIVISOR = BigInt(PERCENT_MAX_BP);

export type Discount =
  { kind: "none" } | { kind: "percent"; bp: number } | { kind: "amount"; clp: number };

export type TaxTreatment = "taxable" | "exempt";

export type LineInput = {
  quantityMilli: number;
  unitPriceClp: number;
  taxTreatment: TaxTreatment;
  discount: Discount;
};

export type CalcInput = {
  lines: LineInput[];
  globalDiscount: Discount;
  taxRateBp: number;
};

export type LineResult = {
  grossClp: number;
  discountClp: number;
  totalClp: number;
};

export type QuoteTotals = {
  lines: LineResult[];
  subtotalTaxableClp: number;
  subtotalExemptClp: number;
  subtotalClp: number;
  /** Informativo: suma de los descuentos de línea (el global va aparte). */
  lineDiscountsClp: number;
  globalDiscountClp: number;
  globalDiscountTaxableClp: number;
  globalDiscountExemptClp: number;
  netTaxableClp: number;
  netExemptClp: number;
  taxClp: number;
  totalClp: number;
};

export type CalcIssueCode =
  | "too_many_lines"
  | "invalid_quantity"
  | "invalid_price"
  | "invalid_discount"
  | "invalid_tax_treatment"
  | "invalid_tax_rate"
  | "line_discount_exceeds_gross"
  | "line_gross_too_large"
  | "global_discount_exceeds_subtotal"
  | "total_too_large";

/** `lineIndex` es la posición (desde 0) de la línea con el problema; `null` si es de toda la cotización. */
export type CalcIssue = { code: CalcIssueCode; lineIndex: number | null };

export type CalcResult = { ok: true; totals: QuoteTotals } | { ok: false; issues: CalcIssue[] };

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Revisa la forma de un descuento. El tope del descuento en pesos se revisa aparte (contra bruto o subtotal). */
function isValidDiscount(discount: Discount): boolean {
  switch (discount.kind) {
    case "none":
      return true;
    case "percent":
      return isIntInRange(discount.bp, 0, PERCENT_MAX_BP);
    case "amount":
      return isIntInRange(discount.clp, 0, MAX_CLP);
    default:
      return false;
  }
}

/** Descuento en pesos (entero) para una base dada; el descuento en pesos nunca se recorta. */
function discountAmount(discount: Discount, base: bigint): bigint {
  if (discount.kind === "percent") return roundHalfUpDiv(base * BigInt(discount.bp), BP_DIVISOR);
  if (discount.kind === "amount") return BigInt(discount.clp);
  return ZERO;
}

/**
 * Orden exacto de evaluación de errores (la copia SQL `app.quote_calc_v1` debe seguirlo):
 *  1. Más de 200 líneas: devuelve solo `too_many_lines` y no mira nada más.
 *  2. Tasa de IVA fuera de 0..10.000 pb: `invalid_tax_rate` (sin posición). No corta: sigue.
 *  3. Por cada línea, en orden, se acumulan todos sus problemas de forma, en este orden:
 *     `invalid_quantity`, `invalid_price`, `invalid_discount`, `invalid_tax_treatment`.
 *  4. Solo si esa línea quedó bien de forma, se calcula y se revisa, y se informa a lo más uno:
 *     `line_gross_too_large`, y si no, `line_discount_exceeds_gross`.
 *  5. Si hasta aquí hay algún problema (tasa o líneas), se devuelven todos juntos, en orden de
 *     aparición, y no se evalúa el descuento global.
 *  6. Descuento global con forma mala: solo `invalid_discount` (posición null).
 *  7. Descuento global mayor que el subtotal: solo `global_discount_exceeds_subtotal`.
 *  8. Total sobre el tope: solo `total_too_large`.
 */
export function calculateQuote(input: CalcInput): CalcResult {
  if (input.lines.length > QUOTE_MAX_LINES) {
    return { ok: false, issues: [{ code: "too_many_lines", lineIndex: null }] };
  }
  const issues: CalcIssue[] = [];
  if (!isIntInRange(input.taxRateBp, 0, TAX_RATE_MAX_BP)) {
    issues.push({ code: "invalid_tax_rate", lineIndex: null });
  }

  type Computed = { gross: bigint; discount: bigint; total: bigint; taxable: boolean };
  const computed: Computed[] = [];
  input.lines.forEach((line, lineIndex) => {
    let valid = true;
    if (!isIntInRange(line.quantityMilli, QUANTITY_MIN_MILLI, QUANTITY_MAX_MILLI)) {
      issues.push({ code: "invalid_quantity", lineIndex });
      valid = false;
    }
    if (!isIntInRange(line.unitPriceClp, 0, UNIT_PRICE_MAX_CLP)) {
      issues.push({ code: "invalid_price", lineIndex });
      valid = false;
    }
    if (!isValidDiscount(line.discount)) {
      issues.push({ code: "invalid_discount", lineIndex });
      valid = false;
    }
    if (line.taxTreatment !== "taxable" && line.taxTreatment !== "exempt") {
      issues.push({ code: "invalid_tax_treatment", lineIndex });
      valid = false;
    }
    if (!valid) return;

    // ① bruto: cantidad (milésimas) × precio / 1000
    const gross = roundHalfUpDiv(
      BigInt(line.quantityMilli) * BigInt(line.unitPriceClp),
      MILLI_PER_UNIT,
    );
    if (gross > BigInt(LINE_GROSS_MAX_CLP)) {
      issues.push({ code: "line_gross_too_large", lineIndex });
      return;
    }
    // ② descuento de línea (% redondeado; $ exacto, por el total de la línea)
    const discount = discountAmount(line.discount, gross);
    if (discount > gross) {
      issues.push({ code: "line_discount_exceeds_gross", lineIndex });
      return;
    }
    computed.push({
      gross,
      discount,
      total: gross - discount,
      taxable: line.taxTreatment === "taxable",
    });
  });
  if (issues.length > 0) return { ok: false, issues };

  let subtotalTaxable = ZERO;
  let subtotalExempt = ZERO;
  let lineDiscounts = ZERO;
  for (const line of computed) {
    if (line.taxable) subtotalTaxable += line.total;
    else subtotalExempt += line.total;
    lineDiscounts += line.discount;
  }
  const subtotal = subtotalTaxable + subtotalExempt;

  if (!isValidDiscount(input.globalDiscount)) {
    return { ok: false, issues: [{ code: "invalid_discount", lineIndex: null }] };
  }
  // ② descuento global
  const globalDiscount = discountAmount(input.globalDiscount, subtotal);
  if (globalDiscount > subtotal) {
    return { ok: false, issues: [{ code: "global_discount_exceeds_subtotal", lineIndex: null }] };
  }
  // ③ reparto proporcional entre afecto y exento; el resto va al exento
  const globalTaxable =
    subtotal === ZERO ? ZERO : roundHalfUpDiv(globalDiscount * subtotalTaxable, subtotal);
  const globalExempt = globalDiscount - globalTaxable;

  const netTaxable = subtotalTaxable - globalTaxable;
  const netExempt = subtotalExempt - globalExempt;
  // ④ IVA, una sola vez, sobre el neto afecto
  const tax = roundHalfUpDiv(netTaxable * BigInt(input.taxRateBp), BP_DIVISOR);
  const total = netTaxable + netExempt + tax;
  if (total > BigInt(QUOTE_TOTAL_MAX_CLP)) {
    return { ok: false, issues: [{ code: "total_too_large", lineIndex: null }] };
  }

  return {
    ok: true,
    totals: {
      lines: computed.map((line) => ({
        grossClp: Number(line.gross),
        discountClp: Number(line.discount),
        totalClp: Number(line.total),
      })),
      subtotalTaxableClp: Number(subtotalTaxable),
      subtotalExemptClp: Number(subtotalExempt),
      subtotalClp: Number(subtotal),
      lineDiscountsClp: Number(lineDiscounts),
      globalDiscountClp: Number(globalDiscount),
      globalDiscountTaxableClp: Number(globalTaxable),
      globalDiscountExemptClp: Number(globalExempt),
      netTaxableClp: Number(netTaxable),
      netExemptClp: Number(netExempt),
      taxClp: Number(tax),
      totalClp: Number(total),
    },
  };
}
