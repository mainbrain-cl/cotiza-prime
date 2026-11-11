import { describe, expect, it } from "vitest";
import { RULE_CASES } from "./rule-cases";
import {
  APPROVAL_BP_SCALE,
  approvalMetrics,
  approvalReasons,
  isApprovalMode,
  priceRebateOfLines,
  requiresApproval,
  type ApprovalRule,
} from "./rule";

describe("la tabla de casos de la regla de aprobación", () => {
  it("tiene casos y nombres distintos", () => {
    expect(RULE_CASES.length).toBeGreaterThanOrEqual(18);
    expect(new Set(RULE_CASES.map((c) => c.name)).size).toBe(RULE_CASES.length);
  });

  for (const c of RULE_CASES) {
    it(c.name, () => {
      const metrics = approvalMetrics(c.totals);
      expect(metrics.discountBp).toBe(c.discountBp);
      expect(metrics.totalClp).toBe(c.totals.totalClp);
      expect(metrics.discountClp).toBe(
        c.totals.lineDiscountsClp + c.totals.globalDiscountClp + c.totals.priceRebateClp,
      );
      expect(metrics.priceRebateClp).toBe(c.totals.priceRebateClp);
      expect(approvalReasons(c.rule, metrics)).toEqual(c.reasons);
      expect(requiresApproval(c.rule, metrics)).toBe(c.reasons.length > 0);
    });
  }
});

describe("bordes de la regla", () => {
  const amountOver = (clp: number): ApprovalRule => ({
    mode: "conditional",
    amountThresholdClp: clp,
    discountThresholdBp: null,
  });
  const totalOf = (totalClp: number) =>
    approvalMetrics({
      subtotalClp: totalClp,
      lineDiscountsClp: 0,
      globalDiscountClp: 0,
      totalClp,
      priceRebateClp: 0,
    });

  it("el monto se compara con el total estrictamente mayor", () => {
    expect(approvalReasons(amountOver(2_000_000), totalOf(2_000_000))).toEqual([]);
    expect(approvalReasons(amountOver(2_000_000), totalOf(2_000_001))).toEqual(["amount"]);
  });

  it("el porcentaje se redondea a dos decimales, mitad hacia arriba, antes de comparar (D6)", () => {
    // 1/20000 = 0,005 % → 0,5 centésima → sube a 1.
    expect(
      approvalMetrics({
        subtotalClp: 19_999,
        lineDiscountsClp: 1,
        globalDiscountClp: 0,
        totalClp: 1,
        priceRebateClp: 0,
      }).discountBp,
    ).toBe(1);
    // 1/30000 = 0,0033 % → 0,33 centésima → baja a 0, pero el umbral 0 mira pesos, no el porcentaje (D5).
    const tiny = approvalMetrics({
      subtotalClp: 29_999,
      lineDiscountsClp: 1,
      globalDiscountClp: 0,
      totalClp: 1,
      priceRebateClp: 0,
    });
    expect(tiny.discountBp).toBe(0);
    expect(
      approvalReasons(
        { mode: "conditional", amountThresholdClp: null, discountThresholdBp: 0 },
        tiny,
      ),
    ).toEqual(["discount"]);
  });

  it("con montos de hasta 10¹² no se pierde exactitud (bigint por dentro)", () => {
    const max = 999_999_999_999;
    // descuento × 10.000 = 10¹⁶, más que el entero seguro de JavaScript (≈ 9 × 10¹⁵).
    expect(Number.isSafeInteger(max * APPROVAL_BP_SCALE)).toBe(false);
    // bruto = 10¹² − 1; descuento = 499.999.999.999 → 50,00000000005 % → 5.000 (mitad hacia arriba).
    expect(
      approvalMetrics({
        subtotalClp: 500_000_000_000,
        lineDiscountsClp: 499_999_999_999,
        globalDiscountClp: 0,
        totalClp: 1,
        priceRebateClp: 0,
      }).discountBp,
    ).toBe(5_000);
    // bruto = 10¹² − 1; descuento = 10¹² − 2 → 99,9999999999 % → 10.000 al redondear.
    expect(
      approvalMetrics({
        subtotalClp: 1,
        lineDiscountsClp: max - 1,
        globalDiscountClp: 0,
        totalClp: 1,
        priceRebateClp: 0,
      }).discountBp,
    ).toBe(10_000);
  });

  it("«Siempre» y «Nunca» no miran las cifras", () => {
    const huge = approvalMetrics({
      subtotalClp: 1,
      lineDiscountsClp: 0,
      globalDiscountClp: 0,
      totalClp: 1,
      priceRebateClp: 0,
    });
    expect(
      approvalReasons(
        { mode: "always", amountThresholdClp: null, discountThresholdBp: null },
        huge,
      ),
    ).toEqual(["always"]);
    expect(
      approvalReasons({ mode: "never", amountThresholdClp: 1, discountThresholdBp: 0 }, huge),
    ).toEqual([]);
  });

  it("isApprovalMode reconoce solo los tres modos", () => {
    expect(["never", "always", "conditional"].every(isApprovalMode)).toBe(true);
    expect(isApprovalMode("sometimes")).toBe(false);
    expect(isApprovalMode(null)).toBe(false);
  });
});

describe("priceRebateOfLines: la rebaja de precio contra el catálogo", () => {
  // Una línea de 2 unidades (2.000 milésimas) con catálogo $10.000: lista $20.000.
  const line = (
    grossClp: number,
    catalogUnitPriceClp: number | null = 10_000,
    quantityMilli = 2_000,
  ) => ({
    quantityMilli,
    grossClp,
    catalogUnitPriceClp,
  });

  it("precio de catálogo: sin rebaja", () => {
    expect(priceRebateOfLines([line(20_000)])).toBe(0);
  });
  it("precio bajado a mano: cantidad × (catálogo − precio)", () => {
    expect(priceRebateOfLines([line(15_000)])).toBe(5_000);
  });
  it("precio mayor que el catálogo: nunca una rebaja negativa", () => {
    expect(priceRebateOfLines([line(26_000)])).toBe(0);
  });
  it("una línea cara no compensa a una barata", () => {
    expect(priceRebateOfLines([line(15_000), line(26_000)])).toBe(5_000);
    expect(priceRebateOfLines([line(26_000), line(15_000), line(18_000)])).toBe(7_000);
  });
  it("línea libre (sin catálogo): no suma", () => {
    expect(priceRebateOfLines([line(1, null)])).toBe(0);
    expect(priceRebateOfLines([])).toBe(0);
  });
  it("redondeo mitad hacia arriba, igual que el bruto: 0,5 unidades × $1.001 = $500,5 → $501", () => {
    // lista = round(500 × 1001 / 1000) = round(500,5) = 501; bruto guardado $400
    expect(priceRebateOfLines([line(400, 1_001, 500)])).toBe(101);
  });
  it("cantidades y montos grandes no pierden exactitud", () => {
    const big = priceRebateOfLines([line(1, 999_999_999_999, 1_000)]);
    expect(big).toBe(999_999_999_998);
  });
});
