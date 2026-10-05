import { describe, expect, it } from "vitest";
import { MAX_CLP } from "@/lib/money/clp";
import { roundHalfUpDiv } from "@/lib/money/rounding";
import { calculateQuote, QUOTE_CALC_VERSION, type CalcInput, type LineInput } from "./calc";
import { CALC_CASES, EXTRA_CALC_CASES } from "./calc-cases";
import { generateInputs, PROPERTY_SEED } from "./calc-random";

const PROPERTY_RUNS = 10_000;

describe("casos conocidos K01 a K39", () => {
  it("son 39, con identificadores únicos y seguidos", () => {
    expect(CALC_CASES).toHaveLength(39);
    CALC_CASES.forEach((testCase, index) => {
      expect(testCase.id).toBe(`K${String(index + 1).padStart(2, "0")}`);
    });
  });

  for (const testCase of CALC_CASES) {
    it(`${testCase.id} · ${testCase.description}`, () => {
      expect(calculateQuote(testCase.input)).toEqual(testCase.expected);
    });
  }
});

describe("casos extra del orden de errores", () => {
  for (const testCase of EXTRA_CALC_CASES) {
    it(`${testCase.id} · ${testCase.description}`, () => {
      expect(calculateQuote(testCase.input)).toEqual(testCase.expected);
    });
  }
});

describe("otras reglas", () => {
  it("declara su versión", () => {
    expect(QUOTE_CALC_VERSION).toBe("quote-calc-v1");
  });

  it("informa todos los errores de línea con su posición", () => {
    const result = calculateQuote({
      lines: [
        {
          quantityMilli: 1000,
          unitPriceClp: 10,
          taxTreatment: "taxable",
          discount: { kind: "none" },
        },
        { quantityMilli: 0, unitPriceClp: 10, taxTreatment: "taxable", discount: { kind: "none" } },
        {
          quantityMilli: 1000,
          unitPriceClp: -1,
          taxTreatment: "exempt",
          discount: { kind: "none" },
        },
      ],
      globalDiscount: { kind: "none" },
      taxRateBp: 1900,
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "invalid_quantity", lineIndex: 1 },
        { code: "invalid_price", lineIndex: 2 },
      ],
    });
  });

  it("rechaza números que no son enteros seguros", () => {
    const line = (quantityMilli: number, unitPriceClp: number): LineInput => ({
      quantityMilli,
      unitPriceClp,
      taxTreatment: "taxable",
      discount: { kind: "none" },
    });
    const run = (lines: LineInput[], taxRateBp = 1900) =>
      calculateQuote({ lines, globalDiscount: { kind: "none" }, taxRateBp });
    expect(run([line(1.5, 100)]).ok).toBe(false);
    expect(run([line(1000, 100.5)]).ok).toBe(false);
    expect(run([line(1000, Number.NaN)]).ok).toBe(false);
    expect(run([line(1000, MAX_CLP + 1)]).ok).toBe(false);
    expect(run([line(1000, 100)], 10_001)).toEqual({
      ok: false,
      issues: [{ code: "invalid_tax_rate", lineIndex: null }],
    });
  });

  it("rechaza un descuento global con forma inválida", () => {
    const result = calculateQuote({
      lines: [],
      globalDiscount: { kind: "percent", bp: 10_001 },
      taxRateBp: 1900,
    });
    expect(result).toEqual({ ok: false, issues: [{ code: "invalid_discount", lineIndex: null }] });
  });

  it("acepta 200 líneas", () => {
    const lines = Array.from({ length: 200 }, () => ({
      quantityMilli: 1000,
      unitPriceClp: 1,
      taxTreatment: "taxable" as const,
      discount: { kind: "none" as const },
    }));
    const result = calculateQuote({ lines, globalDiscount: { kind: "none" }, taxRateBp: 1900 });
    expect(result.ok && result.totals.subtotalClp).toBe(200);
  });
});

describe(
  `propiedades con ${PROPERTY_RUNS} cotizaciones generadas (semilla fija)`,
  { timeout: 60_000 },
  () => {
    const inputs = generateInputs(PROPERTY_RUNS, PROPERTY_SEED);
    const results = inputs.map((input) => ({ input, result: calculateQuote(input) }));

    it("la mayoría de las cotizaciones generadas son válidas", () => {
      const valid = results.filter(({ result }) => result.ok).length;
      expect(valid).toBeGreaterThan(PROPERTY_RUNS * 0.95);
    });

    it("todo es entero seguro y nunca negativo", () => {
      let invalid = 0;
      for (const { result } of results) {
        if (!result.ok) continue;
        const t = result.totals;
        const values = [
          t.subtotalTaxableClp,
          t.subtotalExemptClp,
          t.subtotalClp,
          t.lineDiscountsClp,
          t.globalDiscountClp,
          t.globalDiscountTaxableClp,
          t.globalDiscountExemptClp,
          t.netTaxableClp,
          t.netExemptClp,
          t.taxClp,
          t.totalClp,
          ...t.lines.flatMap((l) => [l.grossClp, l.discountClp, l.totalClp]),
        ];
        for (const value of values) {
          if (!Number.isSafeInteger(value) || value < 0) invalid += 1;
        }
        if (t.totalClp > MAX_CLP) invalid += 1;
      }
      expect(invalid).toBe(0);
    });

    it("el subtotal es la suma de los totales de línea y las líneas cuadran", () => {
      for (const { result } of results) {
        if (!result.ok) continue;
        const t = result.totals;
        expect(t.subtotalClp).toBe(t.lines.reduce((sum, l) => sum + l.totalClp, 0));
        expect(t.subtotalClp).toBe(t.subtotalTaxableClp + t.subtotalExemptClp);
        expect(t.lineDiscountsClp).toBe(t.lines.reduce((sum, l) => sum + l.discountClp, 0));
        for (const l of t.lines) {
          expect(l.totalClp).toBe(l.grossClp - l.discountClp);
          expect(l.discountClp).toBeLessThanOrEqual(l.grossClp);
        }
      }
    });

    it("Subtotal - Descuento global = neto afecto + neto exento, y total = netos + IVA", () => {
      for (const { result } of results) {
        if (!result.ok) continue;
        const t = result.totals;
        expect(t.subtotalClp - t.globalDiscountClp).toBe(t.netTaxableClp + t.netExemptClp);
        expect(t.totalClp).toBe(t.netTaxableClp + t.netExemptClp + t.taxClp);
      }
    });

    it("el descuento global repartido nunca pasa de cada subtotal", () => {
      for (const { result } of results) {
        if (!result.ok) continue;
        const t = result.totals;
        expect(t.globalDiscountTaxableClp).toBeLessThanOrEqual(t.subtotalTaxableClp);
        expect(t.globalDiscountExemptClp).toBeLessThanOrEqual(t.subtotalExemptClp);
        expect(t.globalDiscountClp).toBe(t.globalDiscountTaxableClp + t.globalDiscountExemptClp);
      }
    });

    it("reordenar las líneas no cambia los totales", () => {
      for (const { input, result } of results) {
        if (!result.ok) continue;
        const reversed = calculateQuote({ ...input, lines: [...input.lines].reverse() });
        expect(reversed.ok).toBe(true);
        if (!reversed.ok) continue;
        expect({ ...reversed.totals, lines: [] }).toEqual({ ...result.totals, lines: [] });
        expect(reversed.totals.lines).toEqual([...result.totals.lines].reverse());
      }
    });

    it("sin descuentos, total = suma de brutos + IVA de la suma de brutos afectos", () => {
      let checked = 0;
      for (const { input, result } of results) {
        if (!result.ok) continue;
        const noDiscount: CalcInput = {
          lines: input.lines.map((l) => ({ ...l, discount: { kind: "none" } })),
          globalDiscount: { kind: "none" },
          taxRateBp: input.taxRateBp,
        };
        const plain = calculateQuote(noDiscount);
        if (!plain.ok) continue;
        let grossTaxable = 0;
        let grossAll = 0;
        plain.totals.lines.forEach((line, index) => {
          grossAll += line.grossClp;
          if (noDiscount.lines[index].taxTreatment === "taxable") grossTaxable += line.grossClp;
        });
        const expectedTax = Number(
          roundHalfUpDiv(BigInt(grossTaxable) * BigInt(input.taxRateBp), BigInt(10_000)),
        );
        expect(plain.totals.totalClp).toBe(grossAll + expectedTax);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(PROPERTY_RUNS * 0.9);
    });
  },
);
