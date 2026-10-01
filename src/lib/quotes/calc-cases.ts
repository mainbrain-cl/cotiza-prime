/**
 * Casos conocidos del cálculo de cotizaciones (cotizaciones-y-calculo.md §3.4): K01 a K39.
 *
 * Son datos puros y exportados: los usa la prueba unitaria de `calculateQuote` y los usará la
 * prueba de paridad contra la copia en SQL (`app.quote_calc_v1`). Los valores esperados están
 * escritos a mano desde la tabla del plan; nunca se calculan con el código que se prueba.
 * Cantidades en milésimas (2,5 = 2500), descuentos en puntos base (10% = 1000).
 */

import type { CalcInput, CalcIssueCode, Discount, LineInput, QuoteTotals } from "./calc";

export type ExpectedIssue = { code: CalcIssueCode; lineIndex: number | null };

export type CalcCase = {
  id: string;
  description: string;
  input: CalcInput;
  expected: { ok: true; totals: QuoteTotals } | { ok: false; issues: ExpectedIssue[] };
};

const NONE: Discount = { kind: "none" };
const VAT_19_BP = 1900;

const pct = (bp: number): Discount => ({ kind: "percent", bp });
const amt = (clp: number): Discount => ({ kind: "amount", clp });

/** Línea afecta (A). */
const A = (quantityMilli: number, unitPriceClp: number, discount: Discount = NONE): LineInput => ({
  quantityMilli,
  unitPriceClp,
  taxTreatment: "taxable",
  discount,
});

/** Línea exenta (E). */
const E = (quantityMilli: number, unitPriceClp: number, discount: Discount = NONE): LineInput => ({
  quantityMilli,
  unitPriceClp,
  taxTreatment: "exempt",
  discount,
});

type ExpectedLine = [gross: number, discount: number];

/**
 * Resultado esperado según las columnas de la tabla del plan.
 * El subtotal afecto / exento se deduce de NA + DG(A) y NE + DG(E).
 */
function ok(
  lines: ExpectedLine[],
  columns: {
    subtotal: number;
    globalTaxable: number;
    globalExempt: number;
    netTaxable: number;
    netExempt: number;
    tax: number;
    total: number;
  },
): { ok: true; totals: QuoteTotals } {
  const { subtotal, globalTaxable, globalExempt, netTaxable, netExempt, tax, total } = columns;
  return {
    ok: true,
    totals: {
      lines: lines.map(([grossClp, discountClp]) => ({
        grossClp,
        discountClp,
        totalClp: grossClp - discountClp,
      })),
      subtotalTaxableClp: netTaxable + globalTaxable,
      subtotalExemptClp: netExempt + globalExempt,
      subtotalClp: subtotal,
      lineDiscountsClp: lines.reduce((sum, [, discountClp]) => sum + discountClp, 0),
      globalDiscountClp: globalTaxable + globalExempt,
      globalDiscountTaxableClp: globalTaxable,
      globalDiscountExemptClp: globalExempt,
      netTaxableClp: netTaxable,
      netExemptClp: netExempt,
      taxClp: tax,
      totalClp: total,
    },
  };
}

const fails = (code: CalcIssueCode, lineIndex: number | null = null) => ({
  ok: false as const,
  issues: [{ code, lineIndex }],
});

const input = (
  lines: LineInput[],
  globalDiscount: Discount = NONE,
  taxRateBp = VAT_19_BP,
): CalcInput => ({ lines, globalDiscount, taxRateBp });

const K21_LINES = [A(1000, 100_000), E(1000, 50_000)];
const K21_EXPECTED_LINES: ExpectedLine[] = [
  [100_000, 0],
  [50_000, 0],
];
const K21_COLUMNS = {
  subtotal: 150_000,
  globalTaxable: 0,
  globalExempt: 0,
  netTaxable: 100_000,
  netExempt: 50_000,
  tax: 19_000,
  total: 169_000,
};

export const CALC_CASES: CalcCase[] = [
  {
    id: "K01",
    description: "sin líneas",
    input: input([]),
    expected: ok([], {
      subtotal: 0,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 0,
      netExempt: 0,
      tax: 0,
      total: 0,
    }),
  },
  {
    id: "K02",
    description: "1 × 100.000 afecto",
    input: input([A(1000, 100_000)]),
    expected: ok([[100_000, 0]], {
      subtotal: 100_000,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 100_000,
      netExempt: 0,
      tax: 19_000,
      total: 119_000,
    }),
  },
  {
    id: "K03",
    description: "1 × 0 afecto",
    input: input([A(1000, 0)]),
    expected: ok([[0, 0]], {
      subtotal: 0,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 0,
      netExempt: 0,
      tax: 0,
      total: 0,
    }),
  },
  {
    id: "K04",
    description: "2,5 × 18.000 afecto",
    input: input([A(2500, 18_000)]),
    expected: ok([[45_000, 0]], {
      subtotal: 45_000,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 45_000,
      netExempt: 0,
      tax: 8550,
      total: 53_550,
    }),
  },
  {
    id: "K05",
    description: "0,333 × 1.000 afecto",
    input: input([A(333, 1000)]),
    expected: ok([[333, 0]], {
      subtotal: 333,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 333,
      netExempt: 0,
      tax: 63,
      total: 396,
    }),
  },
  {
    id: "K06",
    description: "1,5 × 1.001 afecto (1.501,5 sube a 1.502)",
    input: input([A(1500, 1001)]),
    expected: ok([[1502, 0]], {
      subtotal: 1502,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 1502,
      netExempt: 0,
      tax: 285,
      total: 1787,
    }),
  },
  {
    id: "K07",
    description: "0,001 × 500 afecto (0,5 sube a 1)",
    input: input([A(1, 500)]),
    expected: ok([[1, 0]], {
      subtotal: 1,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 1,
      netExempt: 0,
      tax: 0,
      total: 1,
    }),
  },
  {
    id: "K08",
    description: "0,001 × 499 afecto (0,499 baja a 0)",
    input: input([A(1, 499)]),
    expected: ok([[0, 0]], {
      subtotal: 0,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 0,
      netExempt: 0,
      tax: 0,
      total: 0,
    }),
  },
  {
    id: "K09",
    description: "1 × 50 afecto (IVA 9,5 sube a 10)",
    input: input([A(1000, 50)]),
    expected: ok([[50, 0]], {
      subtotal: 50,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 50,
      netExempt: 0,
      tax: 10,
      total: 60,
    }),
  },
  {
    id: "K10",
    description: "3 × 50 afecto (IVA 28,5 sube a 29)",
    input: input([A(3000, 50)]),
    expected: ok([[150, 0]], {
      subtotal: 150,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 150,
      netExempt: 0,
      tax: 29,
      total: 179,
    }),
  },
  {
    id: "K11",
    description: "3 líneas de 0,5 × 1.001 afecto (501 cada una); el IVA se calcula una vez",
    input: input([A(500, 1001), A(500, 1001), A(500, 1001)]),
    expected: ok(
      [
        [501, 0],
        [501, 0],
        [501, 0],
      ],
      {
        subtotal: 1503,
        globalTaxable: 0,
        globalExempt: 0,
        netTaxable: 1503,
        netExempt: 0,
        tax: 286,
        total: 1789,
      },
    ),
  },
  {
    id: "K12",
    description: "1 × 100.000 afecto, 10% en la línea",
    input: input([A(1000, 100_000, pct(1000))]),
    expected: ok([[100_000, 10_000]], {
      subtotal: 90_000,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 90_000,
      netExempt: 0,
      tax: 17_100,
      total: 107_100,
    }),
  },
  {
    id: "K13",
    description: "1 × 1.005 afecto, 10% (100,5 sube a 101)",
    input: input([A(1000, 1005, pct(1000))]),
    expected: ok([[1005, 101]], {
      subtotal: 904,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 904,
      netExempt: 0,
      tax: 172,
      total: 1076,
    }),
  },
  {
    id: "K14",
    description: "1 × 1.000 afecto, 12,5%",
    input: input([A(1000, 1000, pct(1250))]),
    expected: ok([[1000, 125]], {
      subtotal: 875,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 875,
      netExempt: 0,
      tax: 166,
      total: 1041,
    }),
  },
  {
    id: "K15",
    description: "1 × 1 afecto, 50% (0,5 sube a 1)",
    input: input([A(1000, 1, pct(5000))]),
    expected: ok([[1, 1]], {
      subtotal: 0,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 0,
      netExempt: 0,
      tax: 0,
      total: 0,
    }),
  },
  {
    id: "K16",
    description: "2 × 30.000 afecto, $5.000 por el total de la línea",
    input: input([A(2000, 30_000, amt(5000))]),
    expected: ok([[60_000, 5000]], {
      subtotal: 55_000,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 55_000,
      netExempt: 0,
      tax: 10_450,
      total: 65_450,
    }),
  },
  {
    id: "K17",
    description: "1 × 20.000 afecto, $20.000 (queda en cero)",
    input: input([A(1000, 20_000, amt(20_000))]),
    expected: ok([[20_000, 20_000]], {
      subtotal: 0,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 0,
      netExempt: 0,
      tax: 0,
      total: 0,
    }),
  },
  {
    id: "K18",
    description: "1 × 20.000 afecto, 100%",
    input: input([A(1000, 20_000, pct(10_000))]),
    expected: ok([[20_000, 20_000]], {
      subtotal: 0,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 0,
      netExempt: 0,
      tax: 0,
      total: 0,
    }),
  },
  {
    id: "K19",
    description: "1 × 20.000 afecto, $20.001 (más que el bruto)",
    input: input([A(1000, 20_000, amt(20_001))]),
    expected: fails("line_discount_exceeds_gross", 0),
  },
  {
    id: "K20",
    description: "1 × 50.000 exento",
    input: input([E(1000, 50_000)]),
    expected: ok([[50_000, 0]], {
      subtotal: 50_000,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 0,
      netExempt: 50_000,
      tax: 0,
      total: 50_000,
    }),
  },
  {
    id: "K21",
    description: "1 × 100.000 afecto + 1 × 50.000 exento",
    input: input(K21_LINES),
    expected: ok(K21_EXPECTED_LINES, K21_COLUMNS),
  },
  {
    id: "K22",
    description: "igual que K21, descuento global 10% (se reparte 10.000 / 5.000)",
    input: input(K21_LINES, pct(1000)),
    expected: ok(K21_EXPECTED_LINES, {
      subtotal: 150_000,
      globalTaxable: 10_000,
      globalExempt: 5000,
      netTaxable: 90_000,
      netExempt: 45_000,
      tax: 17_100,
      total: 152_100,
    }),
  },
  {
    id: "K23",
    description: "1 × 10.000 afecto + 1 × 5.001 exento, descuento global $1.000 (667 / 333)",
    input: input([A(1000, 10_000), E(1000, 5001)], amt(1000)),
    expected: ok(
      [
        [10_000, 0],
        [5001, 0],
      ],
      {
        subtotal: 15_001,
        globalTaxable: 667,
        globalExempt: 333,
        netTaxable: 9333,
        netExempt: 4668,
        tax: 1773,
        total: 15_774,
      },
    ),
  },
  {
    id: "K24",
    description: "1 × 1 afecto + 1 × 1 exento, descuento global $1 (1 / 0)",
    input: input([A(1000, 1), E(1000, 1)], amt(1)),
    expected: ok(
      [
        [1, 0],
        [1, 0],
      ],
      {
        subtotal: 2,
        globalTaxable: 1,
        globalExempt: 0,
        netTaxable: 0,
        netExempt: 1,
        tax: 0,
        total: 1,
      },
    ),
  },
  {
    id: "K25",
    description: "1 × 1.005 afecto, descuento global 10% (100,5 sube a 101)",
    input: input([A(1000, 1005)], pct(1000)),
    expected: ok([[1005, 0]], {
      subtotal: 1005,
      globalTaxable: 101,
      globalExempt: 0,
      netTaxable: 904,
      netExempt: 0,
      tax: 172,
      total: 1076,
    }),
  },
  {
    id: "K26",
    description: "3 × 10.000 afecto con 10% + 1 × 5.000 afecto, descuento global 5%",
    input: input([A(3000, 10_000, pct(1000)), A(1000, 5000)], pct(500)),
    expected: ok(
      [
        [30_000, 3000],
        [5000, 0],
      ],
      {
        subtotal: 32_000,
        globalTaxable: 1600,
        globalExempt: 0,
        netTaxable: 30_400,
        netExempt: 0,
        tax: 5776,
        total: 36_176,
      },
    ),
  },
  {
    id: "K27",
    description: "1 × 10.000 afecto, descuento global $10.000 (todo)",
    input: input([A(1000, 10_000)], amt(10_000)),
    expected: ok([[10_000, 0]], {
      subtotal: 10_000,
      globalTaxable: 10_000,
      globalExempt: 0,
      netTaxable: 0,
      netExempt: 0,
      tax: 0,
      total: 0,
    }),
  },
  {
    id: "K28",
    description: "1 × 10.000 afecto, descuento global $10.001 (se rechaza)",
    input: input([A(1000, 10_000)], amt(10_001)),
    expected: fails("global_discount_exceeds_subtotal"),
  },
  {
    id: "K29",
    description: "sin líneas, descuento global $1",
    input: input([], amt(1)),
    expected: fails("global_discount_exceeds_subtotal"),
  },
  {
    id: "K30",
    description: "1 × 10.000 exento, descuento global 10% (0 / 1.000)",
    input: input([E(1000, 10_000)], pct(1000)),
    expected: ok([[10_000, 0]], {
      subtotal: 10_000,
      globalTaxable: 0,
      globalExempt: 1000,
      netTaxable: 0,
      netExempt: 9000,
      tax: 0,
      total: 9000,
    }),
  },
  {
    id: "K31",
    description: "1 × 800.000.000.000 afecto",
    input: input([A(1000, 800_000_000_000)]),
    expected: ok([[800_000_000_000, 0]], {
      subtotal: 800_000_000_000,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 800_000_000_000,
      netExempt: 0,
      tax: 152_000_000_000,
      total: 952_000_000_000,
    }),
  },
  {
    id: "K32",
    description: "1.000.000 × 1.000.000 exento (justo el tope)",
    input: input([E(1_000_000_000, 1_000_000)]),
    expected: ok([[1_000_000_000_000, 0]], {
      subtotal: 1_000_000_000_000,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 0,
      netExempt: 1_000_000_000_000,
      tax: 0,
      total: 1_000_000_000_000,
    }),
  },
  {
    id: "K33",
    description: "1 × 900.000.000.000 afecto (con IVA pasa el tope)",
    input: input([A(1000, 900_000_000_000)]),
    expected: fails("total_too_large"),
  },
  {
    id: "K34",
    description: "1.000.000 × 1.000.000.000.000 afecto (el bruto pasa el tope)",
    input: input([A(1_000_000_000, 1_000_000_000_000)]),
    expected: fails("line_gross_too_large", 0),
  },
  {
    id: "K35",
    description: "cantidad 0",
    input: input([A(0, 1000)]),
    expected: fails("invalid_quantity", 0),
  },
  {
    id: "K36",
    description: "descuento de 10.001 puntos base (100,01%)",
    input: input([A(1000, 1000, pct(10_001))]),
    expected: fails("invalid_discount", 0),
  },
  {
    id: "K37",
    description: "1 × 1.005 afecto con tasa de 1.000 pb (IVA 100,5 sube a 101)",
    input: input([A(1000, 1005)], NONE, 1000),
    expected: ok([[1005, 0]], {
      subtotal: 1005,
      globalTaxable: 0,
      globalExempt: 0,
      netTaxable: 1005,
      netExempt: 0,
      tax: 101,
      total: 1106,
    }),
  },
  {
    id: "K38",
    description: "201 líneas (el máximo es 200)",
    input: input(Array.from({ length: 201 }, () => A(1000, 1))),
    expected: fails("too_many_lines"),
  },
  {
    id: "K39",
    description: "K21 con las líneas en orden inverso: mismos totales",
    input: input([...K21_LINES].reverse()),
    expected: ok([...K21_EXPECTED_LINES].reverse(), K21_COLUMNS),
  },
];
