/**
 * Las reglas de precio y descuento de las líneas de una cotización (H-041, docs/arquitectura/h-041-precios-bloqueados.md §2.2 y §2.7).
 *
 * Función pura: sin base de datos, sin red, sin `server-only` (la leen la pantalla, las acciones y las pruebas). La que MANDA vive
 * en la base de datos (`app.line_rule_issues`, `app.quote_line_rules_check`, migración `price_locks`): es la que rechaza el guardado
 * y el envío aunque la petición llegue directo a la API. Esta copia sirve a la pantalla (el candado, el «Máximo 10 %», el bloqueo de
 * `/enviar`). Si cambias una regla aquí, cámbiala allá: `tests/db/line-rules-parity.test.ts` exige que respondan lo mismo con la
 * tabla `line-rules-cases.ts` y con 2.000 casos al azar de semilla fija.
 *
 * La regla se aplica a quien NO tiene el permiso `catalog.price_lock.override` (hoy el Comercial). Quien lo tiene se la salta; entonces
 * `lockedPriceOverrides` dice qué líneas cambió de verdad.
 *   · `price_locked@i`: la línea es de un servicio del catálogo con el precio bloqueado HOY y se cotiza a otro precio que el de
 *     catálogo que la línea congeló al agregarse (subirlo tampoco vale). Un precio bloqueado SÍ admite descuento hasta el tope.
 *   · `discount_over_cap@i`: el descuento de la línea pasa del tope. En porcentaje: más que el tope. En pesos: más que el tope
 *     aplicado al bruto de la línea, redondeado mitad hacia arriba (así $1.005 al 10 % = $101 no se rechaza por el redondeo).
 *   · `global_discount_over_cap`: lo mismo para el descuento general, medido SOLO (no sumado al de las líneas), sobre el subtotal ya
 *     con los descuentos de línea.
 *   · Sin tope (`null`) no hay límite; con tope 0 no se permite ningún descuento. Solo cuentan los campos de descuento: bajar el
 *     precio de una línea sin candado no cuenta contra el tope (lo ve la regla de aprobación, H-040).
 *   · `catalog_item_not_allowed@i` NO lo calcula esta función: lo decide el gancho de H-042 al guardar una línea nueva del catálogo;
 *     aquí solo se sabe leer en el mensaje de error.
 * Los índices `@i` empiezan en 0, como los de la calculadora. Todo en `bigint`: cantidad × precio llega a 10²¹.
 */
import { roundHalfUpDiv } from "@/lib/money/rounding";
import type { Discount } from "@/lib/quotes/calc";
import { formatPercentBp } from "@/lib/quotes/format";

/** Tope más alto que se puede fijar, en centésimas de punto: 99,99 % (igual al de la base, `tenants_max_discount_bp_range`). */
export const MAX_DISCOUNT_BP_LIMIT = 9_999;
/** Centésimas de punto que hay en un 100 %. */
const BP_SCALE = BigInt(10_000);

export const LINE_RULE_CODES = [
  "price_locked",
  "discount_over_cap",
  "global_discount_over_cap",
  "catalog_item_not_allowed",
] as const;
export type LineRuleCode = (typeof LINE_RULE_CODES)[number];

/**
 * Un problema; `lineIndex` (desde 0) es `null` en los del descuento general. `unknown` solo sale de leer un mensaje con un código
 * que esta versión no conoce (una base más nueva que la aplicación).
 */
export type LineRuleIssue = { code: LineRuleCode | "unknown"; lineIndex: number | null };

/** Lo que la regla mira de una línea. */
export type RuleLine = {
  /** El servicio de catálogo de la línea tiene hoy el precio bloqueado (`false` en una línea libre). */
  priceLocked: boolean;
  /** Precio de catálogo que la línea congeló al agregarse; `null` en una línea libre. */
  catalogUnitPriceClp: number | null;
  /** El precio que se quiere cotizar. */
  unitPriceClp: number;
  discount: Discount;
  /** Bruto de la línea: cantidad × precio, antes de su descuento. */
  grossClp: number;
};

export type RuleGlobalDiscount = {
  discount: Discount;
  /** Subtotal: la suma de las líneas ya con sus descuentos. */
  baseClp: number;
};

export type LineRulesInput = {
  lines: readonly RuleLine[];
  global: RuleGlobalDiscount | null;
  /** El tope de la organización en centésimas de punto (1.000 = 10 %); `null` = sin tope. */
  maxDiscountBp: number | null;
  /** La persona tiene `catalog.price_lock.override`: se salta la regla. */
  canOverride: boolean;
};

/** El tope aplicado a un monto en pesos, mitad hacia arriba: lo más que puede valer un descuento en pesos sobre ese monto. */
export function maxDiscountClp(baseClp: number | bigint, maxDiscountBp: number): bigint {
  return roundHalfUpDiv(BigInt(baseClp) * BigInt(maxDiscountBp), BP_SCALE);
}

function discountOverCap(discount: Discount, baseClp: number, maxDiscountBp: number | null) {
  if (maxDiscountBp === null) return false;
  if (discount.kind === "percent") return discount.bp > maxDiscountBp;
  if (discount.kind === "amount")
    return BigInt(discount.clp) > maxDiscountClp(baseClp, maxDiscountBp);
  return false;
}

function priceLockBroken(line: RuleLine): boolean {
  return (
    line.priceLocked &&
    line.catalogUnitPriceClp !== null &&
    BigInt(line.unitPriceClp) !== BigInt(line.catalogUnitPriceClp)
  );
}

/** Los problemas, en el orden de la base: por línea `price_locked` y `discount_over_cap`, y al final el del descuento general. */
export function lineRuleIssues(input: LineRulesInput): LineRuleIssue[] {
  if (input.canOverride) return [];
  const issues: LineRuleIssue[] = [];
  input.lines.forEach((line, lineIndex) => {
    if (priceLockBroken(line)) issues.push({ code: "price_locked", lineIndex });
    if (discountOverCap(line.discount, line.grossClp, input.maxDiscountBp)) {
      issues.push({ code: "discount_over_cap", lineIndex });
    }
  });
  if (
    input.global &&
    discountOverCap(input.global.discount, input.global.baseClp, input.maxDiscountBp)
  ) {
    issues.push({ code: "global_discount_over_cap", lineIndex: null });
  }
  return issues;
}

/** Las líneas con el precio bloqueado que se cotizan a otro precio (índices desde 0): lo que se anota si alguien con permiso lo hace. */
export function lockedPriceOverrides(lines: readonly RuleLine[]): number[] {
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (priceLockBroken(line)) found.push(index);
  });
  return found;
}

/** Un problema como lo escribe la base: `price_locked@2` o `global_discount_over_cap`. */
export function formatLineRuleIssue(issue: LineRuleIssue): string {
  return issue.lineIndex === null ? issue.code : `${issue.code}@${issue.lineIndex}`;
}

const MESSAGE_PREFIX = "line_rules_invalid:";

/**
 * Lee el mensaje de error de la base (`line_rules_invalid: price_locked@0,discount_over_cap@2,global_discount_over_cap`).
 * Devuelve `null` si el mensaje no es de esta regla. Un código que no se conoce queda como `unknown` y la pantalla cae en el
 * mensaje general (`lineRuleFieldErrors` lo pone en `form`).
 */
export function parseLineRulesError(message: string | null | undefined): LineRuleIssue[] | null {
  if (typeof message !== "string") return null;
  const at = message.indexOf(MESSAGE_PREFIX);
  if (at === -1) return null;
  const list = message.slice(at + MESSAGE_PREFIX.length).trim();
  const issues: LineRuleIssue[] = [];
  for (const raw of list.split(",")) {
    const match = /^([a-z_]+)(?:@(\d+))?$/.exec(raw.trim());
    if (!match || !(LINE_RULE_CODES as readonly string[]).includes(match[1])) {
      issues.push({ code: "unknown", lineIndex: null });
      continue;
    }
    issues.push({
      code: match[1] as LineRuleCode,
      lineIndex: match[2] === undefined ? null : Number(match[2]),
    });
  }
  return issues;
}

/** El error de la línea en la pantalla: su precio no coincide con el de la línea (se arregla volviendo al precio con que se agregó). */
export const PRICE_LOCKED_LINE_MESSAGE =
  "El precio de este servicio está bloqueado. Usa el precio con que se agregó a la cotización.";
/**
 * El servidor rechazó una línea NUEVA del catálogo porque la lista de servicios de esta persona cambió desde que se abrió la cotización
 * (H-042): un Administrador la cambió con el editor abierto. El editor vuelve a pedir el catálogo al verlo.
 */
export const NOT_ALLOWED_LINE_MESSAGE =
  "Ya no puedes cotizar este servicio: un Administrador cambió tu lista. Quita la línea para guardar.";
/**
 * El error de la línea cuando lo manda el servidor: el catálogo cambió (el precio o el candado) con la cotización abierta, así que
 * «volver al precio con que se agregó» no lo arregla; se actualiza la línea con el catálogo de hoy.
 */
export const PRICE_LOCKED_STALE_LINE_MESSAGE =
  "El precio de este servicio cambió o se bloqueó en el catálogo. Actualiza la línea para usar el precio de hoy.";

export type LineRuleMessageOptions = {
  /** El tope vigente, para decir «máximo 10 %» o «no permite descuentos» (0). */
  maxDiscountBp?: number | null;
  /** El texto del precio bloqueado; el de la pantalla por defecto. */
  priceLockedMessage?: string;
};

function capText(options: LineRuleMessageOptions): string {
  const bp = options.maxDiscountBp;
  if (bp === null || bp === undefined)
    return "El descuento pasa del máximo que permite tu organización.";
  if (bp === 0) return "Tu organización no permite descuentos.";
  return `El descuento pasa del máximo que permite tu organización (${formatPercentBp(bp)} %).`;
}

/**
 * Los problemas como errores por campo, con las mismas llaves que usa el editor (`items.2.price`, `items.0.discount`,
 * `globalDiscount`, `items.1.name`) y texto para quien cotiza. Lo que esta versión no entiende cae en `form`.
 */
export function lineRuleFieldErrors(
  issues: readonly LineRuleIssue[],
  options: LineRuleMessageOptions = {},
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const index = issue.lineIndex;
    switch (issue.code) {
      case "price_locked":
        if (index !== null && index >= 0) {
          errors[`items.${index}.price`] = options.priceLockedMessage ?? PRICE_LOCKED_LINE_MESSAGE;
          continue;
        }
        break;
      case "discount_over_cap":
        if (index !== null && index >= 0) {
          errors[`items.${index}.discount`] = capText(options);
          continue;
        }
        break;
      case "global_discount_over_cap":
        if (index === null) {
          errors.globalDiscount = capText(options);
          continue;
        }
        break;
      case "catalog_item_not_allowed":
        if (index !== null && index >= 0) {
          errors[`items.${index}.name`] = NOT_ALLOWED_LINE_MESSAGE;
          continue;
        }
        break;
      case "unknown":
        break;
    }
    errors.form = "Revisa los precios y descuentos: algo no cumple las reglas de tu organización.";
  }
  return errors;
}

/** ¿Un tope es válido? `null` (sin tope) o un entero de 0 a 9.999. */
export function isValidMaxDiscountBp(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= MAX_DISCOUNT_BP_LIMIT)
  );
}
