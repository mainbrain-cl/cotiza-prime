import type { Discount } from "./calc";
import { maxDiscountHint } from "./discount-cap";
import {
  lineRuleIssues,
  parseLineRulesError,
  type LineRuleIssue,
  type RuleLine,
} from "./line-rules";

/**
 * El bloqueo de `/enviar` por las reglas de precio y descuento (H-041). Lo calcula la misma función pura que usa el editor
 * (`line-rules.ts`) con lo GUARDADO en la cotización y lo que el catálogo y la organización dicen HOY; el servidor lo vuelve a
 * decidir en la base de datos al enviar (disparador `quote_packages_a_line_rules_gate`), aunque la petición llegue sin pasar por
 * la pantalla. Quien se salta la regla (Dueño y Administrador) nunca queda bloqueado.
 */

export const LINE_RULES_UNAVAILABLE_MESSAGE =
  "No pudimos revisar los precios y descuentos de esta cotización. Intenta de nuevo en unos minutos.";

/** El mensaje cuando la base rechaza el envío por estas reglas y no se puede dar el detalle (otra persona cambió algo en el medio). */
export const LINE_RULES_GENERIC_MESSAGE =
  "Esta cotización no cumple las reglas de precio y descuento de tu organización. Vuelve a la cotización, revisa los precios y descuentos marcados y guarda de nuevo.";

/** Cuántos problemas se cuentan con su frase antes de resumir el resto. */
const MAX_LISTED = 3;

export type SavedLineForRules = {
  catalog_item_id: string | null;
  catalog_unit_price_clp: number | null;
  unit_price_clp: number;
  discount_kind: "none" | "percent" | "amount";
  discount_value: number;
  gross_clp: number;
};

export type SavedQuoteForRules = {
  global_discount_kind: "none" | "percent" | "amount";
  global_discount_value: number;
  subtotal_clp: number;
};

function toDiscount(kind: "none" | "percent" | "amount", value: number): Discount {
  if (kind === "percent") return { kind, bp: value };
  if (kind === "amount") return { kind, clp: value };
  return { kind: "none" };
}

function capSuffix(maxDiscountBp: number | null): string {
  if (maxDiscountBp === null) return "";
  return maxDiscountBp === 0
    ? " Tu organización no permite descuentos."
    : ` ${maxDiscountHint(maxDiscountBp)}.`;
}

function describeIssue(issue: LineRuleIssue, maxDiscountBp: number | null): string {
  const line = (issue.lineIndex ?? 0) + 1;
  switch (issue.code) {
    case "price_locked":
      return `La línea ${line} tiene un precio bloqueado distinto al precio con que se agregó. Vuelve a la cotización y usa ese precio.`;
    case "discount_over_cap":
      return `El descuento de la línea ${line} pasa del máximo que permite tu organización.${capSuffix(maxDiscountBp)}`;
    case "global_discount_over_cap":
      return `El descuento general pasa del máximo que permite tu organización.${capSuffix(maxDiscountBp)}`;
    case "catalog_item_not_allowed":
      return `La línea ${line} es un servicio que no puedes cotizar. Quítala de la cotización.`;
    default:
      return LINE_RULES_GENERIC_MESSAGE;
  }
}

/** Las primeras tres frases y cuántos problemas más hay. */
function describeIssues(issues: readonly LineRuleIssue[], maxDiscountBp: number | null): string {
  const listed = issues.slice(0, MAX_LISTED).map((issue) => describeIssue(issue, maxDiscountBp));
  const rest = issues.length - listed.length;
  if (rest > 0) listed.push(rest === 1 ? "Hay 1 problema más." : `Hay ${rest} problemas más.`);
  return [...new Set(listed)].join(" ");
}

/** `null` si la cotización puede salir; si no, la frase que dice qué corregir (las primeras tres cosas y cuántas más hay). */
export function lineRulesBlockMessage(input: {
  items: readonly SavedLineForRules[];
  quote: SavedQuoteForRules;
  /** Servicios del catálogo con el precio bloqueado hoy. */
  lockedCatalogIds: ReadonlySet<string>;
  maxDiscountBp: number | null;
  canOverride: boolean;
}): string | null {
  const lines: RuleLine[] = input.items.map((item) => ({
    priceLocked: item.catalog_item_id !== null && input.lockedCatalogIds.has(item.catalog_item_id),
    catalogUnitPriceClp: item.catalog_item_id === null ? null : item.catalog_unit_price_clp,
    unitPriceClp: item.unit_price_clp,
    discount: toDiscount(item.discount_kind, item.discount_value),
    grossClp: item.gross_clp,
  }));
  const issues = lineRuleIssues({
    lines,
    global: {
      discount: toDiscount(input.quote.global_discount_kind, input.quote.global_discount_value),
      baseClp: input.quote.subtotal_clp,
    },
    maxDiscountBp: input.maxDiscountBp,
    canOverride: input.canOverride,
  });
  return issues.length === 0 ? null : describeIssues(issues, input.maxDiscountBp);
}

/**
 * El mensaje cuando la base rechaza `prepare_quote_send` con `line_rules_invalid`. Llega con el código CP422 y la lista de
 * problemas en el mensaje del error (`line_rules_invalid: price_locked@1,discount_over_cap@0`). `null` si el error no es de esta regla.
 */
export function lineRulesPrepareError(reason: string): string | null {
  const issues = parseLineRulesError(reason);
  if (issues === null) return null;
  // El tope no viaja en el error: se dice lo que pasó sin la cifra (la pantalla de la cotización la muestra).
  return issues.length === 0 ? LINE_RULES_GENERIC_MESSAGE : describeIssues(issues, null);
}
