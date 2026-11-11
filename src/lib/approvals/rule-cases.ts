/**
 * La tabla de casos de la regla de aprobación (docs/arquitectura/sprint-5-h-040-aprobaciones.md §3). La comparten la prueba
 * unitaria (`rule.test.ts`) y la de paridad con la base de datos (`tests/db/approval-rule-parity.test.ts`): ahí cada caso se
 * calcula con las funciones de SQL y tiene que dar lo mismo que con `rule.ts`. Sin dependencias: la leen Vitest y Playwright.
 */
import type { ApprovalReason, ApprovalRule, ApprovalTotals } from "./rule";

export type RuleCase = {
  name: string;
  rule: ApprovalRule;
  totals: ApprovalTotals;
  /** El descuento en centésimas de punto que debe dar `approvalMetrics`. */
  discountBp: number;
  reasons: ApprovalReason[];
};

const NEVER: ApprovalRule = { mode: "never", amountThresholdClp: null, discountThresholdBp: null };
const ALWAYS: ApprovalRule = {
  mode: "always",
  amountThresholdClp: null,
  discountThresholdBp: null,
};
const amountOver = (clp: number): ApprovalRule => ({
  mode: "conditional",
  amountThresholdClp: clp,
  discountThresholdBp: null,
});
const discountOver = (bp: number): ApprovalRule => ({
  mode: "conditional",
  amountThresholdClp: null,
  discountThresholdBp: bp,
});
const MAX = 999_999_999_999;

/** Totales sueltos: lo que importa de cada caso es el total, el bruto y el descuento. */
function totals(over: Partial<ApprovalTotals>): ApprovalTotals {
  return {
    subtotalClp: 1_000_000,
    lineDiscountsClp: 0,
    globalDiscountClp: 0,
    totalClp: 1_190_000,
    priceRebateClp: 0,
    ...over,
  };
}

export const RULE_CASES: readonly RuleCase[] = [
  {
    name: "umbral $2.000.000 y total exactamente $2.000.000: no pide",
    rule: amountOver(2_000_000),
    totals: totals({ subtotalClp: 1_680_672, totalClp: 2_000_000 }),
    discountBp: 0,
    reasons: [],
  },
  {
    name: "total $2.000.001: pide (monto)",
    rule: amountOver(2_000_000),
    totals: totals({ subtotalClp: 1_680_673, totalClp: 2_000_001 }),
    discountBp: 0,
    reasons: ["amount"],
  },
  {
    name: "descuento 10 % exacto con umbral 10 %: no pide",
    rule: discountOver(1_000),
    totals: totals({ subtotalClp: 900_000, lineDiscountsClp: 100_000, totalClp: 1_071_000 }),
    discountBp: 1_000,
    reasons: [],
  },
  {
    name: "descuento 10,01 % con umbral 10 %: pide (descuento)",
    rule: discountOver(1_000),
    totals: totals({ subtotalClp: 899_900, lineDiscountsClp: 100_100, totalClp: 1_070_881 }),
    discountBp: 1_001,
    reasons: ["discount"],
  },
  {
    name: "solo descuento general de 15 %: pide",
    rule: discountOver(1_000),
    totals: totals({ subtotalClp: 1_000_000, globalDiscountClp: 150_000, totalClp: 1_011_500 }),
    discountBp: 1_500,
    reasons: ["discount"],
  },
  {
    name: "línea de 6 % más general de 5 % (efectivo 10,7 %): pide aunque ninguno pase solo",
    rule: discountOver(1_000),
    // Bruto $1.000.000; descuento de línea $60.000; subtotal $940.000; general 5 % de $940.000 = $47.000.
    totals: totals({
      subtotalClp: 940_000,
      lineDiscountsClp: 60_000,
      globalDiscountClp: 47_000,
      totalClp: 1_062_670,
    }),
    discountBp: 1_070,
    reasons: ["discount"],
  },
  {
    name: "línea de $1.005 con 10 % (redondea a $101 = 10,05 %): pide, conocido en montos chicos",
    rule: discountOver(1_000),
    totals: totals({ subtotalClp: 904, lineDiscountsClp: 101, totalClp: 1_076 }),
    discountBp: 1_005,
    reasons: ["discount"],
  },
  {
    name: "línea de $2.000.005 con 10 % (10,0000 %): no pide",
    rule: discountOver(1_000),
    // 10 % de 2.000.005 = 200.000,5 → 200.001 (mitad hacia arriba): 200.001 / 2.000.005 = 10,00002 % → 1.000 pb.
    totals: totals({ subtotalClp: 1_800_004, lineDiscountsClp: 200_001, totalClp: 2_142_005 }),
    discountBp: 1_000,
    reasons: [],
  },
  {
    name: "bruto $0: descuento 0",
    rule: discountOver(1_000),
    totals: {
      subtotalClp: 0,
      lineDiscountsClp: 0,
      globalDiscountClp: 0,
      totalClp: 0,
      priceRebateClp: 0,
    },
    discountBp: 0,
    reasons: [],
  },
  {
    name: "umbral 0 con un descuento de $1: pide",
    rule: discountOver(0),
    totals: totals({ subtotalClp: 999_999, lineDiscountsClp: 1, totalClp: 1_189_999 }),
    discountBp: 0,
    reasons: ["discount"],
  },
  {
    name: "umbral 0 y ningún descuento: no pide",
    rule: discountOver(0),
    totals: totals({}),
    discountBp: 0,
    reasons: [],
  },
  {
    name: "descuento de 100 % en la línea: el descuento da 10.000 y «Siempre» pide",
    rule: ALWAYS,
    totals: totals({
      subtotalClp: 0,
      lineDiscountsClp: 1_000_000,
      globalDiscountClp: 0,
      totalClp: 0,
    }),
    discountBp: 10_000,
    reasons: ["always"],
  },
  {
    name: "«Siempre» con total $0: pide",
    rule: ALWAYS,
    totals: {
      subtotalClp: 0,
      lineDiscountsClp: 0,
      globalDiscountClp: 0,
      totalClp: 0,
      priceRebateClp: 0,
    },
    discountBp: 0,
    reasons: ["always"],
  },
  {
    name: "«Nunca»: no pide, aunque el monto y el descuento sean enormes",
    rule: NEVER,
    totals: totals({ subtotalClp: 1_000, lineDiscountsClp: 999_000, totalClp: MAX }),
    discountBp: 9_990,
    reasons: [],
  },
  {
    name: "regla combinada, solo pasa el monto",
    rule: { mode: "conditional", amountThresholdClp: 1_000_000, discountThresholdBp: 1_000 },
    totals: totals({ totalClp: 1_190_000 }),
    discountBp: 0,
    reasons: ["amount"],
  },
  {
    name: "regla combinada, solo pasa el descuento",
    rule: { mode: "conditional", amountThresholdClp: 5_000_000, discountThresholdBp: 1_000 },
    totals: totals({ subtotalClp: 800_000, lineDiscountsClp: 200_000, totalClp: 952_000 }),
    discountBp: 2_000,
    reasons: ["discount"],
  },
  {
    name: "regla combinada, pasan los dos: monto y descuento, en ese orden",
    rule: { mode: "conditional", amountThresholdClp: 1_000_000, discountThresholdBp: 1_000 },
    totals: totals({ subtotalClp: 1_000_000, lineDiscountsClp: 200_000, totalClp: 1_190_000 }),
    discountBp: 1_667,
    reasons: ["amount", "discount"],
  },
  {
    name: "regla combinada, no pasa ninguno",
    rule: { mode: "conditional", amountThresholdClp: 5_000_000, discountThresholdBp: 1_000 },
    totals: totals({}),
    discountBp: 0,
    reasons: [],
  },
  {
    name: "montos en el máximo (10¹² − 1): sin desborde",
    rule: { mode: "conditional", amountThresholdClp: MAX - 1, discountThresholdBp: 9_999 },
    totals: {
      subtotalClp: MAX,
      lineDiscountsClp: 0,
      globalDiscountClp: MAX,
      totalClp: MAX,
      priceRebateClp: 0,
    },
    discountBp: 10_000,
    reasons: ["amount", "discount"],
  },
  {
    name: "monto en el máximo y umbral en el máximo: no pide",
    rule: amountOver(MAX),
    totals: totals({ totalClp: MAX }),
    discountBp: 0,
    reasons: [],
  },
  // --- Rebaja de precio contra el catálogo (decisión de Aarón, 2026-11-11) ---
  {
    name: "rebaja de precio sola de 20 % del valor de lista, sin descuento declarado: pide con umbral 10 %",
    rule: discountOver(1_000),
    totals: totals({ subtotalClp: 800_000, priceRebateClp: 200_000, totalClp: 952_000 }),
    discountBp: 2_000,
    reasons: ["discount"],
  },
  {
    name: "rebaja de precio de 10 % exacto con umbral 10 %: no pide",
    rule: discountOver(1_000),
    totals: totals({ subtotalClp: 900_000, priceRebateClp: 100_000, totalClp: 1_071_000 }),
    discountBp: 1_000,
    reasons: [],
  },
  {
    name: "rebaja de $1 sobre el 10 % exacto: a dos decimales sigue en 10,00 % (D6), no pide",
    rule: discountOver(1_000),
    totals: totals({ subtotalClp: 899_999, priceRebateClp: 100_001, totalClp: 1_070_999 }),
    discountBp: 1_000,
    reasons: [],
  },
  {
    name: "rebaja de 10,01 % con umbral 10 %: pide",
    rule: discountOver(1_000),
    totals: totals({ subtotalClp: 899_900, priceRebateClp: 100_100, totalClp: 1_070_881 }),
    discountBp: 1_001,
    reasons: ["discount"],
  },
  {
    name: "rebaja, descuento de línea y descuento general se suman sobre el mismo valor de lista",
    rule: discountOver(2_000),
    // Lista $1.000.000: rebaja $150.000, descuento de línea $50.000 y general $30.000 → $230.000 = 23 %.
    totals: totals({
      subtotalClp: 800_000,
      lineDiscountsClp: 50_000,
      globalDiscountClp: 30_000,
      priceRebateClp: 150_000,
      totalClp: 916_300,
    }),
    discountBp: 2_300,
    reasons: ["discount"],
  },
  {
    name: "la rebaja sola ni pasa 10 % ni lo hace el descuento declarado, pero juntos sí: pide",
    rule: discountOver(1_000),
    totals: totals({
      subtotalClp: 880_000,
      lineDiscountsClp: 60_000,
      priceRebateClp: 60_000,
      totalClp: 1_047_200,
    }),
    discountBp: 1_200,
    reasons: ["discount"],
  },
  {
    name: "umbral 0 y una rebaja de $1: pide",
    rule: discountOver(0),
    totals: totals({ subtotalClp: 999_999, priceRebateClp: 1, totalClp: 1_189_999 }),
    discountBp: 0,
    reasons: ["discount"],
  },
  {
    name: "umbral 0 sin rebaja ni descuento: no pide",
    rule: discountOver(0),
    totals: totals({ priceRebateClp: 0 }),
    discountBp: 0,
    reasons: [],
  },
  {
    name: "rebaja y monto: pasan los dos, en ese orden",
    rule: { mode: "conditional", amountThresholdClp: 1_000_000, discountThresholdBp: 1_000 },
    totals: totals({ subtotalClp: 700_000, priceRebateClp: 300_000, totalClp: 1_190_000 }),
    discountBp: 3_000,
    reasons: ["amount", "discount"],
  },
  {
    name: "rebaja enorme: sin desborde",
    rule: discountOver(9_999),
    totals: {
      subtotalClp: 1,
      lineDiscountsClp: 0,
      globalDiscountClp: 0,
      totalClp: 1,
      priceRebateClp: MAX - 1,
    },
    discountBp: 10_000,
    reasons: ["discount"],
  },
];
