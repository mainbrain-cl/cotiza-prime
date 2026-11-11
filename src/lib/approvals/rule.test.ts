import { describe, expect, it } from "vitest";
import { RULE_CASES } from "./rule-cases";
import {
  APPROVAL_BP_SCALE,
  approvalMetrics,
  approvalReasons,
  isApprovalMode,
  priceRebateOfLines,
  ruleLooksAtDiscount,
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
        c.totals.lineDiscountsClp + c.totals.globalDiscountClp + Number(c.totals.priceRebateClp),
      );
      expect(metrics.priceRebateClp).toBe(Number(c.totals.priceRebateClp));
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
  // Una línea de 2 unidades (2.000 milésimas) con catálogo guardado $10.000: lista $20.000.
  const line = (
    grossClp: number,
    catalogUnitPriceClp: number | null = 10_000,
    quantityMilli = 2_000,
    currentCatalogUnitPriceClp?: number | null,
  ) => ({ quantityMilli, grossClp, catalogUnitPriceClp, currentCatalogUnitPriceClp });
  const rebate = (...lines: ReturnType<typeof line>[]) => priceRebateOfLines(lines);
  const BIG = BigInt;

  it("precio de catálogo: sin rebaja", () => {
    expect(rebate(line(20_000))).toBe(BIG(0));
  });
  it("precio bajado a mano: cantidad × (catálogo − precio)", () => {
    expect(rebate(line(15_000))).toBe(BIG(5_000));
  });
  it("precio mayor que el catálogo: nunca una rebaja negativa", () => {
    expect(rebate(line(26_000))).toBe(BIG(0));
  });
  it("una línea cara no compensa a una barata", () => {
    expect(rebate(line(15_000), line(26_000))).toBe(BIG(5_000));
    expect(rebate(line(26_000), line(15_000), line(18_000))).toBe(BIG(7_000));
  });
  it("línea libre (sin catálogo): no suma", () => {
    expect(rebate(line(1, null))).toBe(BIG(0));
    expect(rebate()).toBe(BIG(0));
  });
  it("redondeo mitad hacia arriba, igual que el bruto: 0,5 unidades × $1.001 = $500,5 → $501", () => {
    // lista = round(500 × 1001 / 1000) = round(500,5) = 501; bruto guardado $400
    expect(rebate(line(400, 1_001, 500))).toBe(BIG(101));
  });

  describe("el menor entre el catálogo guardado y el de hoy (decisión de José)", () => {
    it("el catálogo BAJÓ y la persona iguala el precio nuevo: sin rebaja falsa", () => {
      // guardado $10.000, hoy $8.000, puesto $8.000 × 2 = $16.000
      expect(rebate(line(16_000, 10_000, 2_000, 8_000))).toBe(BIG(0));
      // sin mirar el de hoy, sería una rebaja de $4.000
      expect(rebate(line(16_000, 10_000, 2_000, null))).toBe(BIG(4_000));
    });
    it("el catálogo bajó y la persona pone menos que el nuevo: la rebaja es contra el nuevo", () => {
      expect(rebate(line(14_000, 10_000, 2_000, 8_000))).toBe(BIG(2_000));
    });
    it("el catálogo SUBIÓ: el menor sigue siendo el guardado, no se abre un hueco ni aparece una rebaja fantasma", () => {
      expect(rebate(line(20_000, 10_000, 2_000, 15_000))).toBe(BIG(0));
      expect(rebate(line(15_000, 10_000, 2_000, 15_000))).toBe(BIG(5_000));
    });
    it("catálogo de hoy igual al guardado: como si no estuviera", () => {
      expect(rebate(line(15_000, 10_000, 2_000, 10_000))).toBe(BIG(5_000));
    });
    it("servicio inactivo (o sin precio de hoy): vale solo el guardado", () => {
      expect(rebate(line(15_000, 10_000, 2_000, null))).toBe(BIG(5_000));
      expect(rebate(line(15_000, 10_000, 2_000, undefined))).toBe(BIG(5_000));
    });
  });

  it("cantidades y montos grandes no pierden exactitud", () => {
    expect(rebate(line(1, 999_999_999_999, 1_000))).toBe(BIG(999_999_999_998));
  });
  it("más allá de 2⁵³ y con resultado impar: igual a un cálculo de referencia con bigint", () => {
    // 999.999,999 unidades × $999.999.999.999 ≈ 10¹⁸ → lista = round(cantidad × catálogo / 1000), más que 2⁵³
    const quantityMilli = 999_999_999;
    const catalog = 999_999_999_999;
    const gross = 1;
    const expected =
      (BIG(2) * BIG(quantityMilli) * BIG(catalog) + BIG(1000)) / BIG(2000) - BIG(gross);
    expect(expected > BIG(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(expected % BIG(2)).toBe(BIG(1));
    expect(rebate(line(gross, catalog, quantityMilli))).toBe(expected);
    // y diez líneas así suman exactamente diez veces
    expect(rebate(...Array.from({ length: 10 }, () => line(gross, catalog, quantityMilli)))).toBe(
      expected * BIG(10),
    );
  });
  it("la rebaja de 10 líneas de 10⁶ unidades a $10¹² no desborda: da un descuento de 100 %", () => {
    const total = rebate(
      ...Array.from({ length: 10 }, () => line(1, 1_000_000_000_000, 1_000_000_000)),
    );
    expect(total).toBe(BIG(10) * (BIG(10) ** BIG(18) - BIG(1)));
    const metrics = approvalMetrics({
      subtotalClp: 10,
      lineDiscountsClp: 0,
      globalDiscountClp: 0,
      totalClp: 12,
      priceRebateClp: total,
    });
    expect(metrics.discountBp).toBe(10_000);
    expect(
      approvalReasons(
        { mode: "conditional", amountThresholdClp: null, discountThresholdBp: 9_999 },
        metrics,
      ),
    ).toEqual(["discount"]);
  });
});

describe("ruleLooksAtDiscount: solo entonces se calcula la rebaja", () => {
  it("solo el modo condicional con umbral de descuento", () => {
    const base = { amountThresholdClp: null, discountThresholdBp: null };
    expect(ruleLooksAtDiscount({ mode: "never", ...base })).toBe(false);
    expect(ruleLooksAtDiscount({ mode: "always", ...base })).toBe(false);
    expect(ruleLooksAtDiscount({ mode: "conditional", ...base, amountThresholdClp: 5 })).toBe(
      false,
    );
    expect(ruleLooksAtDiscount({ mode: "conditional", ...base, discountThresholdBp: 0 })).toBe(
      true,
    );
    expect(ruleLooksAtDiscount({ mode: "conditional", ...base, discountThresholdBp: 1_000 })).toBe(
      true,
    );
  });
});
