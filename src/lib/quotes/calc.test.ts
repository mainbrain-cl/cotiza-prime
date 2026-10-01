import { describe, expect, it } from "vitest";
import { MAX_CLP } from "@/lib/money/clp";
import { roundHalfUpDiv } from "@/lib/money/rounding";
import {
  calculateQuote,
  QUOTE_CALC_VERSION,
  type CalcInput,
  type Discount,
  type LineInput,
} from "./calc";
import { CALC_CASES } from "./calc-cases";

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

/** Generador con semilla fija (mulberry32): mismos números en cada corrida, sin librerías. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROPERTY_RUNS = 10_000;
const PROPERTY_SEED = 20_261_001;

function generateInputs(count: number, seed: number): CalcInput[] {
  const random = createRandom(seed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(items: T[]): T => items[int(0, items.length - 1)];

  const inputs: CalcInput[] = [];
  for (let i = 0; i < count; i += 1) {
    const lineCount = int(0, 12);
    const lines: LineInput[] = [];
    for (let l = 0; l < lineCount; l += 1) {
      const quantityMilli = pick([int(1, 20), int(1, 5000), int(1000, 100_000), int(1, 5_000_000)]);
      const unitPriceClp = pick([0, int(1, 100), int(1, 5000), int(1, 2_000_000)]);
      // Cota segura del bruto (el real es ese valor redondeado hacia abajo o arriba por $1 como mucho).
      const grossFloor = Math.floor((quantityMilli * unitPriceClp) / 1000);
      const kind = pick(["none", "percent", "amount"] as const);
      let discount: Discount = { kind: "none" };
      if (kind === "percent")
        discount = { kind: "percent", bp: pick([0, int(0, 10_000), 1250, 10_000]) };
      if (kind === "amount") discount = { kind: "amount", clp: int(0, grossFloor) };
      lines.push({
        quantityMilli,
        unitPriceClp,
        taxTreatment: random() < 0.3 ? "exempt" : "taxable",
        discount,
      });
    }
    const taxRateBp = pick([1900, 1900, 1900, 0, 1000, int(0, 10_000)]);
    const base: CalcInput = { lines, globalDiscount: { kind: "none" }, taxRateBp };
    const without = calculateQuote(base);
    let globalDiscount: Discount = { kind: "none" };
    const globalKind = pick(["none", "percent", "amount"] as const);
    if (globalKind === "percent")
      globalDiscount = { kind: "percent", bp: pick([int(0, 10_000), 500, 10_000]) };
    if (globalKind === "amount" && without.ok) {
      globalDiscount = { kind: "amount", clp: int(0, without.totals.subtotalClp) };
    }
    inputs.push({ lines, globalDiscount, taxRateBp });
  }
  return inputs;
}

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
