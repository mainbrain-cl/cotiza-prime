/**
 * La regla de aprobación y la función que decide si una cotización la necesita (H-040,
 * docs/arquitectura/sprint-5-h-040-aprobaciones.md §3).
 *
 * Función pura: sin base de datos, sin red. La que MANDA vive en la base de datos (`app.approval_discount_bp`,
 * `app.approval_rule_reasons` y `app.quote_approval_check`, migración `approval_rules`): es la que rechaza el envío, aunque
 * la petición llegue directo a la API. Esta copia sirve a la pantalla (la frase, el bloqueo del botón «Enviar» y, en el
 * sprint 6, el motivo de la solicitud de aprobación). Si cambias una regla aquí, cámbiala allá: la prueba
 * `tests/db/approval-rule-parity.test.ts` exige que respondan lo mismo con la tabla `rule-cases.ts`.
 *
 * Qué se compara (decisiones D3 a D6 del diseño):
 *   · MONTO: el TOTAL CON IVA de la cotización; pide aprobación si lo supera ESTRICTAMENTE.
 *   · DESCUENTO: la suma de los descuentos de cada línea, el descuento general y la REBAJA DE PRECIO (decisión de Aarón,
 *     2026-11-11: poner un precio menor al del catálogo cuenta igual que un descuento), sobre el valor ANTES de todo descuento y
 *     sin IVA, en centésimas de punto (1.000 = 10 %), redondeado mitad hacia arriba ANTES de comparar. Pide aprobación si lo
 *     supera estrictamente; con umbral 0, ante cualquier descuento en pesos.
 *   · REBAJA DE PRECIO: por línea, max(0, cantidad × precio de catálogo − bruto de la línea). El precio de catálogo es el que la
 *     línea congeló al agregarse (lo copia el servidor desde `catalog_items`, nunca viene del navegador). Nunca es negativa ni
 *     compensa otra línea; una línea libre (sin catálogo) no suma nada. El valor de lista, la base del porcentaje, es el bruto
 *     de las líneas más la rebaja.
 *   · Basta uno de los dos: monto O descuento. Los motivos salen siempre en el orden `always`, `amount`, `discount`.
 */
import { roundHalfUpDiv } from "@/lib/money/rounding";

export const APPROVAL_MODES = ["never", "always", "conditional"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Tope del umbral de monto: igual al de la base de datos (`app.approval_amount_max_clp`). */
export const APPROVAL_AMOUNT_MAX_CLP = 999_999_999_999;
/** Tope del umbral de descuento, en centésimas de punto: 99,99 % (`app.approval_discount_max_bp`). */
export const APPROVAL_DISCOUNT_MAX_BP = 9_999;
/** Centésimas de punto que hay en un 100 %. */
export const APPROVAL_BP_SCALE = 10_000;

export type ApprovalRule = {
  mode: ApprovalMode;
  /** Pesos; se compara con el total con IVA. `null` si la regla no mira el monto. */
  amountThresholdClp: number | null;
  /** Centésimas de punto (1.000 = 10 %). `null` si la regla no mira el descuento. */
  discountThresholdBp: number | null;
};

export type ApprovalReason = "always" | "amount" | "discount";

/** Los totales que guarda la base en `quotes` y de los que sale todo (nunca los manda el navegador). */
export type ApprovalTotals = {
  subtotalClp: number;
  lineDiscountsClp: number;
  globalDiscountClp: number;
  totalClp: number;
  /** Suma de las rebajas de precio de las líneas (ver `priceRebateOfLines`); 0 si ninguna línea costó menos que su catálogo. */
  priceRebateClp: number;
};

export type ApprovalMetrics = {
  totalClp: number;
  /** Descuentos de línea + descuento general + rebaja de precio, en pesos. */
  discountClp: number;
  /** La parte de ese descuento que es rebaja de precio contra el catálogo (0 si no hay). */
  priceRebateClp: number;
  /** Ese descuento sobre el valor antes de descuentos, en centésimas de punto. */
  discountBp: number;
};

const ZERO = BigInt(0);
const BP_SCALE = BigInt(APPROVAL_BP_SCALE);

/** Descuento en centésimas de punto: mitad hacia arriba; bruto 0 → 0. `bigint` porque 10¹² × 10⁴ pasa el entero seguro. */
function discountBpOf(grossClp: number, discountClp: number): number {
  const gross = BigInt(grossClp);
  if (gross <= ZERO) return 0;
  return Number(roundHalfUpDiv(BigInt(discountClp) * BP_SCALE, gross));
}

const MILLI_PER_UNIT = BigInt(1000);

/** Lo que de una línea importa para la rebaja de precio. */
export type RebateLine = {
  quantityMilli: number;
  /** Bruto de la línea ya guardado: cantidad × precio puesto, antes de su descuento. */
  grossClp: number;
  /** Precio de catálogo congelado en la línea; `null` en una línea libre. */
  catalogUnitPriceClp: number | null;
};

/**
 * Rebaja de precio de una cotización: la suma, por línea con catálogo, de max(0, cantidad × catálogo − bruto), en pesos y con
 * el mismo redondeo del bruto (mitad hacia arriba). Gemela de lo que calcula `app.quote_approval_check` desde `quote_items`.
 */
export function priceRebateOfLines(lines: readonly RebateLine[]): number {
  let total = ZERO;
  for (const line of lines) {
    if (line.catalogUnitPriceClp === null) continue;
    const list = roundHalfUpDiv(
      BigInt(line.quantityMilli) * BigInt(line.catalogUnitPriceClp),
      MILLI_PER_UNIT,
    );
    const rebate = list - BigInt(line.grossClp);
    if (rebate > ZERO) total += rebate;
  }
  return Number(total);
}

/** Monto y descuento de una cotización, tal como los compara la regla. */
export function approvalMetrics(totals: ApprovalTotals): ApprovalMetrics {
  const grossClp = totals.subtotalClp + totals.lineDiscountsClp + totals.priceRebateClp;
  const discountClp = totals.lineDiscountsClp + totals.globalDiscountClp + totals.priceRebateClp;
  return {
    totalClp: totals.totalClp,
    discountClp,
    priceRebateClp: totals.priceRebateClp,
    discountBp: discountBpOf(grossClp, discountClp),
  };
}

/** Por qué esta cotización necesita aprobación, en el orden `always`, `amount`, `discount`; vacío si no la necesita. */
export function approvalReasons(rule: ApprovalRule, metrics: ApprovalMetrics): ApprovalReason[] {
  if (rule.mode === "always") return ["always"];
  if (rule.mode !== "conditional") return [];
  const reasons: ApprovalReason[] = [];
  if (rule.amountThresholdClp !== null && metrics.totalClp > rule.amountThresholdClp) {
    reasons.push("amount");
  }
  if (rule.discountThresholdBp !== null) {
    const exceeds =
      rule.discountThresholdBp === 0
        ? metrics.discountClp > 0
        : metrics.discountBp > rule.discountThresholdBp;
    if (exceeds) reasons.push("discount");
  }
  return reasons;
}

export function requiresApproval(rule: ApprovalRule, metrics: ApprovalMetrics): boolean {
  return approvalReasons(rule, metrics).length > 0;
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}
