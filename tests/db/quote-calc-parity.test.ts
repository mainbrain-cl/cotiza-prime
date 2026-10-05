import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateQuote, type CalcInput, type Discount } from "../../src/lib/quotes/calc";
import { CALC_CASES, EXTRA_CALC_CASES } from "../../src/lib/quotes/calc-cases";
import { generateInputs, PROPERTY_SEED } from "../../src/lib/quotes/calc-random";
import { connect } from "./helpers";

// La función de TypeScript (calculateQuote) y la copia de SQL (app.quote_calc_v1) deben dar el
// mismo JSON y los mismos errores, en el mismo orden (cotizaciones-y-calculo.md §3.6 y §8.2).

const PARITY_RUNS = 500;

const discountColumns = (discount: Discount): { kind: string; value: number } => {
  if (discount.kind === "percent") return { kind: "percent", value: discount.bp };
  if (discount.kind === "amount") return { kind: "amount", value: discount.clp };
  return { kind: discount.kind, value: 0 };
};

/** Pasa una entrada de `calculateQuote` a los parámetros de `app.quote_calc_v1`. */
function toSqlArgs(input: CalcInput): [string, string, number, number] {
  const items = input.lines.map((line) => {
    const discount = discountColumns(line.discount);
    return {
      quantity_milli: line.quantityMilli,
      unit_price_clp: line.unitPriceClp,
      tax_treatment: line.taxTreatment,
      discount_kind: discount.kind,
      discount_value: discount.value,
    };
  });
  const global = discountColumns(input.globalDiscount);
  return [JSON.stringify(items), global.kind, global.value, input.taxRateBp];
}

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

async function sqlCalc(input: CalcInput): Promise<unknown> {
  const { rows } = await db.query<{ r: unknown }>(
    "select app.quote_calc_v1($1::jsonb, $2::text, $3::bigint, $4::int) as r",
    toSqlArgs(input),
  );
  return rows[0].r;
}

/** Lo que devuelve TypeScript, con la misma forma que el JSON de SQL. */
const tsCalc = (input: CalcInput): unknown => JSON.parse(JSON.stringify(calculateQuote(input)));

const line = (
  quantityMilli: number,
  unitPriceClp: number,
  taxTreatment: "taxable" | "exempt" = "taxable",
  discount: Discount = { kind: "none" },
) => ({ quantityMilli, unitPriceClp, taxTreatment, discount });

const NONE: Discount = { kind: "none" };

// Casos de orden de errores y de forma que no están en K01–K39.
const ORDER_CASES: [string, CalcInput][] = [
  [
    "tasa mala y línea mala: ambos, tasa primero",
    { lines: [line(0, 1)], globalDiscount: NONE, taxRateBp: 10_001 },
  ],
  ["tasa negativa", { lines: [], globalDiscount: NONE, taxRateBp: -1 }],
  [
    "línea con los cuatro problemas de forma",
    {
      lines: [
        {
          quantityMilli: 0,
          unitPriceClp: -1,
          taxTreatment: "otro" as unknown as "taxable",
          discount: { kind: "percent", bp: 10_001 },
        },
      ],
      globalDiscount: NONE,
      taxRateBp: 1900,
    },
  ],
  [
    "problemas en varias líneas, en orden",
    {
      lines: [
        line(1000, 1000, "taxable", { kind: "amount", clp: 1001 }),
        line(1000, 1000),
        line(1_000_000_001, 5),
        line(1000, 2_000_000_000_000),
      ],
      globalDiscount: NONE,
      taxRateBp: 1900,
    },
  ],
  [
    "bruto demasiado grande no informa también el descuento",
    {
      lines: [line(1_000_000_000, 1_000_000_000_000, "taxable", { kind: "amount", clp: 10 ** 12 })],
      globalDiscount: NONE,
      taxRateBp: 1900,
    },
  ],
  [
    "descuento en pesos negativo",
    {
      lines: [line(1000, 100, "taxable", { kind: "amount", clp: -1 })],
      globalDiscount: NONE,
      taxRateBp: 1900,
    },
  ],
  [
    "descuento global en pesos negativo",
    { lines: [line(1000, 100)], globalDiscount: { kind: "amount", clp: -1 }, taxRateBp: 1900 },
  ],
  [
    "descuento global en pesos sobre el tope",
    {
      lines: [line(1000, 100)],
      globalDiscount: { kind: "amount", clp: 10 ** 12 + 1 },
      taxRateBp: 1900,
    },
  ],
  [
    "descuento global 100% repartido",
    {
      lines: [line(1000, 10_001), line(1000, 5_003, "exempt")],
      globalDiscount: { kind: "percent", bp: 10_000 },
      taxRateBp: 1900,
    },
  ],
  [
    "tasa 0 y tasa 10.000",
    {
      lines: [line(1500, 3333), line(700, 999, "exempt")],
      globalDiscount: { kind: "percent", bp: 333 },
      taxRateBp: 0,
    },
  ],
  [
    "exactamente 200 líneas",
    { lines: Array.from({ length: 200 }, () => line(1, 1)), globalDiscount: NONE, taxRateBp: 1900 },
  ],
  [
    "201 líneas con tasa mala: solo too_many_lines",
    { lines: Array.from({ length: 201 }, () => line(0, 0)), globalDiscount: NONE, taxRateBp: -5 },
  ],
];

describe("app.quote_calc_v1 coincide con calculateQuote", () => {
  for (const testCase of [...CALC_CASES, ...EXTRA_CALC_CASES]) {
    it(`${testCase.id} · ${testCase.description}`, async () => {
      const sql = await sqlCalc(testCase.input);
      expect(sql).toEqual(tsCalc(testCase.input));
      // Y contra lo esperado escrito a mano, por si ambas copias se equivocaran igual.
      expect(sql).toEqual(JSON.parse(JSON.stringify(testCase.expected)));
    });
  }

  for (const [name, input] of ORDER_CASES) {
    it(`orden de errores y bordes · ${name}`, async () => {
      expect(await sqlCalc(input)).toEqual(tsCalc(input));
    });
  }

  it(`${PARITY_RUNS} cotizaciones al azar (semilla fija ${PROPERTY_SEED})`, async () => {
    const inputs = generateInputs(PARITY_RUNS, PROPERTY_SEED);
    const mismatches: unknown[] = [];
    let valid = 0;
    for (const input of inputs) {
      const sql = await sqlCalc(input);
      const ts = tsCalc(input);
      if ((ts as { ok: boolean }).ok) valid += 1;
      if (JSON.stringify(sql) !== JSON.stringify(ts)) {
        // JSON.stringify de jsonb puede reordenar claves: comparar en profundidad antes de reportar.
        try {
          expect(sql).toEqual(ts);
        } catch {
          mismatches.push({ input, sql, ts });
          if (mismatches.length >= 3) break;
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(valid).toBeGreaterThan(PARITY_RUNS * 0.9);
  }, 60_000);

  it("valores que no son enteros ni números se rechazan igual que en TypeScript", async () => {
    const run = async (items: unknown[]) => {
      const { rows } = await db.query<{ r: unknown }>(
        "select app.quote_calc_v1($1::jsonb, 'none', 0, 1900) as r",
        [JSON.stringify(items)],
      );
      return rows[0].r;
    };
    const base = {
      quantity_milli: 1000,
      unit_price_clp: 100,
      tax_treatment: "taxable",
      discount_kind: "none",
      discount_value: 0,
    };
    expect(await run([{ ...base, quantity_milli: 1000.5 }])).toEqual({
      ok: false,
      issues: [{ code: "invalid_quantity", lineIndex: 0 }],
    });
    expect(await run([{ ...base, unit_price_clp: "100" }])).toEqual({
      ok: false,
      issues: [{ code: "invalid_price", lineIndex: 0 }],
    });
    expect(await run([{ ...base, quantity_milli: null, discount_kind: null }])).toEqual({
      ok: false,
      issues: [
        { code: "invalid_quantity", lineIndex: 0 },
        { code: "invalid_discount", lineIndex: 0 },
      ],
    });
    expect(await run([{}])).toEqual({
      ok: false,
      issues: [
        { code: "invalid_quantity", lineIndex: 0 },
        { code: "invalid_price", lineIndex: 0 },
        { code: "invalid_discount", lineIndex: 0 },
        { code: "invalid_tax_treatment", lineIndex: 0 },
      ],
    });
  });
});

describe("app.round_half_up_div", () => {
  it.each([
    [1, 2, 1],
    [499, 1000, 0],
    [500, 1000, 1],
    [501, 1000, 1],
    [0, 7, 0],
    [3, 1, 3],
  ])("%i / %i = %i", async (n, d, expected) => {
    const { rows } = await db.query<{ r: string }>(
      "select app.round_half_up_div($1, $2)::text as r",
      [n, d],
    );
    expect(rows[0].r).toBe(String(expected));
  });

  it("acepta números mayores que bigint", async () => {
    const { rows } = await db.query<{ r: string }>(
      "select app.round_half_up_div(10::numeric ^ 21 + 500, 1000)::text as r",
    );
    expect(rows[0].r).toBe("1000000000000000001");
  });

  it("rechaza numerador negativo y denominador cero", async () => {
    await expect(db.query("select app.round_half_up_div(-1, 2)")).rejects.toThrow();
    await expect(db.query("select app.round_half_up_div(1, 0)")).rejects.toThrow();
  });

  it("la tasa de IVA es 1900", async () => {
    const { rows } = await db.query<{ r: number }>("select app.vat_rate_bp() as r");
    expect(rows[0].r).toBe(1900);
  });
});
