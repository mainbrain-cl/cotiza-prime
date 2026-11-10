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
 *   · DESCUENTO: la suma de los descuentos de cada línea más el descuento general, sobre el valor ANTES de todo descuento y
 *     sin IVA, en centésimas de punto (1.000 = 10 %), redondeado mitad hacia arriba ANTES de comparar. Pide aprobación si lo
 *     supera estrictamente; con umbral 0, ante cualquier descuento en pesos.
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
};

export type ApprovalMetrics = {
  totalClp: number;
  /** Descuentos de línea + descuento general, en pesos. */
  discountClp: number;
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

/** Monto y descuento de una cotización, tal como los compara la regla. */
export function approvalMetrics(totals: ApprovalTotals): ApprovalMetrics {
  const grossClp = totals.subtotalClp + totals.lineDiscountsClp;
  const discountClp = totals.lineDiscountsClp + totals.globalDiscountClp;
  return {
    totalClp: totals.totalClp,
    discountClp,
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
