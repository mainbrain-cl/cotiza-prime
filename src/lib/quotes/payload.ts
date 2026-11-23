/**
 * Del guardado de la pantalla a lo que entiende el cálculo y la función de la base de datos.
 * Puro (sin red): lo usan la acción del servidor y las pruebas.
 */

import type { CalcInput, CalcIssue, Discount, QuoteTotals } from "./calc";
import type { SaveQuotePayload } from "./schemas";

export function toCalcInput(payload: SaveQuotePayload, taxRateBp: number): CalcInput {
  return {
    lines: payload.items.map((item) => ({
      quantityMilli: item.quantityMilli,
      unitPriceClp: item.unitPriceClp,
      taxTreatment: item.taxTreatment,
      discount: item.discount,
    })),
    globalDiscount: payload.globalDiscount,
    taxRateBp,
  };
}

/** Tipo y valor del descuento como los guarda la base: porcentaje en puntos base, pesos enteros. */
export function discountColumns(discount: Discount): { kind: string; value: number } {
  if (discount.kind === "percent") return { kind: "percent", value: discount.bp };
  if (discount.kind === "amount") return { kind: "amount", value: discount.clp };
  return { kind: "none", value: 0 };
}

/** Argumentos de `public.save_quote_draft` (§4). El `tenant_id` no viaja: la base lo saca de la sesión. */
export function toSaveRpcArgs(quoteId: string, payload: SaveQuotePayload, totals: QuoteTotals) {
  const global = discountColumns(payload.globalDiscount);
  return {
    p_quote_id: quoteId,
    p_expected_revision: payload.expectedRevision,
    p_save_id: payload.saveId,
    p_header: {
      customer_id: payload.customerId,
      global_discount: { kind: global.kind, value: global.value },
      validity:
        payload.validity.mode === "days"
          ? { mode: "days", days: payload.validity.days }
          : { mode: "date", date: payload.validity.date },
      observations: payload.observations === "" ? null : payload.observations,
      conditions: payload.conditions === "" ? null : payload.conditions,
      exclusions: payload.exclusions === "" ? null : payload.exclusions,
      footer_note: payload.footerNote === "" ? null : payload.footerNote,
    },
    p_items: payload.items.map((item) => {
      const discount = discountColumns(item.discount);
      return {
        id: item.id,
        catalog_item_id: item.catalogItemId,
        name: item.name,
        description: item.description === "" ? null : item.description,
        unit: item.unit,
        tax_treatment: item.taxTreatment,
        quantity_milli: item.quantityMilli,
        unit_price_clp: item.unitPriceClp,
        discount_kind: discount.kind,
        discount_value: discount.value,
      };
    }),
    p_expected_totals: totals,
  };
}

const ISSUE_MESSAGES: Record<CalcIssue["code"], string> = {
  too_many_lines: "Una cotización admite hasta 200 líneas.",
  invalid_quantity: "Revisa la cantidad: debe ser mayor que 0.",
  invalid_price: "Revisa el precio.",
  invalid_discount: "Revisa el descuento.",
  invalid_tax_treatment: "Revisa si la línea es afecta o exenta de IVA.",
  invalid_tax_rate: "La tasa de IVA de la cotización no es válida.",
  line_discount_exceeds_gross: "El descuento es mayor que el total de la línea.",
  line_gross_too_large: "El total de la línea es demasiado alto. Revisa los ceros.",
  global_discount_exceeds_subtotal: "El descuento global es mayor que el subtotal.",
  total_too_large: "El total de la cotización es demasiado alto. Revisa los ceros.",
};

export function describeCalcIssue(issue: CalcIssue): string {
  return ISSUE_MESSAGES[issue.code];
}

/** Mensajes por campo (`items.2.discount`, `globalDiscount`, `form`) a partir de los problemas del cálculo. */
export function calcIssueFieldErrors(issues: CalcIssue[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const message = describeCalcIssue(issue);
    let key: string;
    if (issue.lineIndex !== null) {
      const field =
        issue.code === "invalid_quantity"
          ? "quantity"
          : issue.code === "invalid_price" || issue.code === "line_gross_too_large"
            ? "price"
            : "discount";
      key = `items.${issue.lineIndex}.${field}`;
    } else {
      key =
        issue.code === "global_discount_exceeds_subtotal" ||
        (issue.code === "invalid_discount" && issue.lineIndex === null)
          ? "globalDiscount"
          : "form";
    }
    errors[key] ??= message;
  }
  return errors;
}
