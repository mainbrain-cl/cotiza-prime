/**
 * Modelo del editor de la cotización: lo que la persona escribe (texto, con coma decimal) y cómo se
 * convierte en datos para el cálculo. Puro y sin React, para probarlo sin pantalla.
 * Los totales que se muestran al escribir salen de `calculateQuote` (el mismo cálculo del servidor);
 * lo que se guarda lo vuelve a calcular el servidor y lo comprueba la base.
 */

import { parseClp } from "@/lib/money/clp";
import {
  calculateQuote,
  type CalcIssue,
  type Discount,
  type QuoteTotals,
  type TaxTreatment,
} from "./calc";
import { formatPercentBp, formatQuantity } from "./format";
import { calcIssueFieldErrors } from "./payload";
import { parsePercent, parseQuantity } from "./parse";
import type { QuoteItemPayload } from "./schemas";
import { QUOTE_ITEM_DESCRIPTION_MAX_LENGTH, QUOTE_ITEM_NAME_MAX_LENGTH } from "./schemas";
import {
  parseValidityDate,
  parseValidityDays,
  QUOTE_TEXT_MAX_LENGTH,
  todayInChile,
  type Validity,
} from "./validity";

export type DiscountKind = "none" | "percent" | "amount";

/** Una línea tal como se edita: los números van como texto. */
export type EditorLine = {
  /** Identidad estable de la línea (se genera en el navegador y se conserva entre guardados). */
  id: string;
  catalogItemId: string | null;
  /** El servicio del catálogo de esta línea hoy está desactivado (informativo). */
  catalogInactive: boolean;
  /**
   * Precio de catálogo con que se cargó la línea (`null` en las líneas libres). Solo sirve para avisar
   * que un precio más bajo cuenta como descuento; la decisión de verdad la toma el servidor al enviar.
   */
  catalogPriceClp: number | null;
  name: string;
  description: string;
  unit: string;
  taxTreatment: TaxTreatment;
  quantity: string;
  price: string;
  discountKind: DiscountKind;
  discount: string;
};

export type ValidityMode = "days" | "date";

export type EditorState = {
  customerId: string;
  lines: EditorLine[];
  globalDiscountKind: DiscountKind;
  globalDiscount: string;
  /** Vigencia en días (desde el envío) o hasta una fecha. */
  validityMode: ValidityMode;
  validityDays: string;
  /** `aaaa-mm-dd` (formato de `<input type="date">`). */
  validityDate: string;
  observations: string;
  conditions: string;
};

/** Contexto de las reglas que dependen de la fecha de hoy. */
export type EditorContext = {
  /** Hoy en Chile, `aaaa-mm-dd`. */
  today: string;
  /** Fecha de vigencia ya guardada (si no se toca, aunque esté en el pasado, se puede guardar). */
  savedValidUntil: string | null;
};

/** Contenido que se guarda (sin la revisión ni la clave del guardado, que pone quien guarda). */
export type DraftContent = {
  customerId: string;
  globalDiscount: Discount;
  validity: Validity;
  /** `null` cuando está vacío. */
  observations: string | null;
  conditions: string | null;
  items: QuoteItemPayload[];
};

export type EditorView = {
  /** Errores por campo: `items.2.price`, `items.0.name`, `globalDiscount`, `validity`, `form`. */
  errors: Record<string, string>;
  content: DraftContent | null;
  totals: QuoteTotals | null;
};

const CLP_MESSAGES = {
  empty: "Escribe el monto.",
  negative: "No puede ser negativo.",
  decimal: "Usa pesos enteros, sin decimales.",
  invalid: "Escribe solo números. Por ejemplo, 15000 o 15.000.",
  too_large: "El monto es demasiado alto. Revisa los ceros.",
} as const;

type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

function parseMoney(text: string): FieldResult<number> {
  const result = parseClp(text);
  return result.ok ? result : { ok: false, message: CLP_MESSAGES[result.reason] };
}

function parseDiscountText(kind: DiscountKind, text: string): FieldResult<Discount> {
  if (kind === "none") return { ok: true, value: { kind: "none" } };
  if (kind === "percent") {
    const result = parsePercent(text);
    return result.ok
      ? { ok: true, value: { kind: "percent", bp: result.value } }
      : { ok: false, message: result.message };
  }
  const result = parseMoney(text);
  return result.ok
    ? { ok: true, value: { kind: "amount", clp: result.value } }
    : { ok: false, message: result.message };
}

/** Lee una línea: devuelve los datos listos o los errores de cada campo. */
export function parseLine(
  line: EditorLine,
  index: number,
): { item: QuoteItemPayload | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = line.name.trim();
  if (name === "") errors[`items.${index}.name`] = "Escribe el nombre de la línea.";
  else if (name.length > QUOTE_ITEM_NAME_MAX_LENGTH) {
    errors[`items.${index}.name`] = "El nombre es demasiado largo.";
  }
  if (line.description.trim().length > QUOTE_ITEM_DESCRIPTION_MAX_LENGTH) {
    errors[`items.${index}.description`] = "La descripción es demasiado larga.";
  }
  const quantity = parseQuantity(line.quantity);
  if (!quantity.ok) errors[`items.${index}.quantity`] = quantity.message;
  const price = parseMoney(line.price);
  if (!price.ok) errors[`items.${index}.price`] = price.message;
  const discount = parseDiscountText(line.discountKind, line.discount);
  if (!discount.ok) errors[`items.${index}.discount`] = discount.message;
  if (!quantity.ok || !price.ok || !discount.ok || Object.keys(errors).length > 0) {
    return { item: null, errors };
  }
  const description = line.description.trim();
  return {
    item: {
      id: line.id,
      catalogItemId: line.catalogItemId,
      name,
      description: description === "" ? null : description,
      unit: line.unit,
      taxTreatment: line.taxTreatment,
      quantityMilli: quantity.value,
      unitPriceClp: price.value,
      discount: discount.value,
    },
    errors,
  };
}

/** Todo lo que se ve de una cotización: errores por campo, contenido a guardar y totales. */
export function evaluateEditor(
  state: EditorState,
  taxRateBp: number,
  context: EditorContext = { today: todayInChile(), savedValidUntil: null },
): EditorView {
  const errors: Record<string, string> = {};
  const items: QuoteItemPayload[] = [];
  let allLinesOk = true;
  state.lines.forEach((line, index) => {
    const parsed = parseLine(line, index);
    Object.assign(errors, parsed.errors);
    if (parsed.item) items.push(parsed.item);
    else allLinesOk = false;
  });
  const global = parseDiscountText(state.globalDiscountKind, state.globalDiscount);
  if (!global.ok) errors.globalDiscount = global.message;

  let validity: Validity | null = null;
  if (state.validityMode === "days") {
    const days = parseValidityDays(state.validityDays);
    if (days.ok) validity = { mode: "days", days: days.value };
    else errors.validity = days.message;
  } else {
    const date = parseValidityDate(state.validityDate, context.today, context.savedValidUntil);
    if (date.ok) validity = { mode: "date", date: date.value };
    else errors.validity = date.message;
  }
  const observations = state.observations.trim();
  const conditions = state.conditions.trim();
  if (observations.length > QUOTE_TEXT_MAX_LENGTH) {
    errors.observations = "Las observaciones son demasiado largas (máximo 4.000 caracteres).";
  }
  if (conditions.length > QUOTE_TEXT_MAX_LENGTH) {
    errors.conditions = "Las condiciones son demasiado largas (máximo 4.000 caracteres).";
  }

  if (!allLinesOk || !global.ok || validity === null || errors.observations || errors.conditions) {
    return { errors, content: null, totals: null };
  }

  const calc = calculateQuote({ lines: items, globalDiscount: global.value, taxRateBp });
  if (!calc.ok) {
    return {
      errors: { ...errors, ...calcIssueFieldErrors(calc.issues as CalcIssue[]) },
      content: null,
      totals: null,
    };
  }
  return {
    errors,
    content: {
      customerId: state.customerId,
      globalDiscount: global.value,
      validity,
      observations: observations === "" ? null : observations,
      conditions: conditions === "" ? null : conditions,
      items,
    },
    totals: calc.totals,
  };
}

/** Clave comparable del contenido guardado: dos guardados con la misma clave son idénticos. */
export function contentKey(content: DraftContent): string {
  return JSON.stringify(content);
}

/** Línea nueva en blanco ("Agregar línea libre"). */
export function newFreeLine(id: string): EditorLine {
  return {
    id,
    catalogItemId: null,
    catalogInactive: false,
    catalogPriceClp: null,
    name: "",
    description: "",
    unit: "service",
    taxTreatment: "taxable",
    quantity: "1",
    price: "",
    discountKind: "none",
    discount: "",
  };
}

/** Línea nueva desde un servicio del catálogo: el precio y el trato tributario se cargan solos. */
export function newCatalogLine(
  id: string,
  item: {
    id: string;
    name: string;
    description: string | null;
    unit: string;
    unitPriceClp: number;
    taxTreatment: TaxTreatment;
  },
): EditorLine {
  return {
    id,
    catalogItemId: item.id,
    catalogInactive: false,
    catalogPriceClp: item.unitPriceClp,
    name: item.name,
    description: item.description ?? "",
    unit: item.unit,
    taxTreatment: item.taxTreatment,
    quantity: "1",
    price: String(item.unitPriceClp),
    discountKind: "none",
    discount: "",
  };
}

/** Línea guardada -> línea del editor (los números pasan a texto con coma). */
export function lineFromSaved(
  row: {
    id: string;
    catalog_item_id: string | null;
    catalog_unit_price_clp: number | null;
    name: string;
    description: string | null;
    unit: string;
    tax_treatment: TaxTreatment;
    quantity_milli: number;
    unit_price_clp: number;
    discount_kind: DiscountKind;
    discount_value: number;
  },
  catalogInactive: boolean,
): EditorLine {
  return {
    id: row.id,
    catalogItemId: row.catalog_item_id,
    catalogInactive,
    catalogPriceClp: row.catalog_item_id === null ? null : row.catalog_unit_price_clp,
    name: row.name,
    description: row.description ?? "",
    unit: row.unit,
    taxTreatment: row.tax_treatment,
    quantity: formatQuantity(row.quantity_milli),
    price: String(row.unit_price_clp),
    discountKind: row.discount_kind,
    discount:
      row.discount_kind === "percent"
        ? formatPercentBp(row.discount_value)
        : row.discount_kind === "amount"
          ? String(row.discount_value)
          : "",
  };
}

/**
 * Precio de catálogo de la línea cuando el precio escrito es más bajo (en pesos enteros); `null` si no hay
 * rebaja que avisar: línea libre, precio vacío o inválido, o precio igual o mayor al del catálogo.
 */
export function priceBelowCatalog(
  line: Pick<EditorLine, "catalogPriceClp" | "price">,
): number | null {
  if (line.catalogPriceClp === null) return null;
  const typed = parseMoney(line.price);
  if (!typed.ok) return null;
  return typed.value < line.catalogPriceClp ? line.catalogPriceClp : null;
}

/** Mueve una línea una posición (-1 arriba, +1 abajo). Devuelve el mismo arreglo si no se puede. */
export function moveLine(lines: EditorLine[], index: number, direction: -1 | 1): EditorLine[] {
  const target = index + direction;
  if (index < 0 || index >= lines.length || target < 0 || target >= lines.length) return lines;
  const next = [...lines];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Vigencia guardada -> campos del editor. Sin vigencia guardada, parte con los días de la organización. */
export function editorValidity(
  quote: {
    validity_mode: "days" | "date" | null;
    validity_days: number | null;
    valid_until: string | null;
  },
  organizationDays: number,
): Pick<EditorState, "validityMode" | "validityDays" | "validityDate"> {
  if (quote.validity_mode === "date" && quote.valid_until) {
    return {
      validityMode: "date",
      validityDays: String(organizationDays),
      validityDate: quote.valid_until,
    };
  }
  return {
    validityMode: "days",
    validityDays: String(quote.validity_days ?? organizationDays),
    validityDate: "",
  };
}
