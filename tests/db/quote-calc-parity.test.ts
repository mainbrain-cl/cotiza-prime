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

/** Pasa un arreglo JSON crudo (como llega a SQL) a la entrada de TypeScript, tal como la leería JSON.parse. */
function rawToInput(items: unknown[], globalDiscount: Discount = NONE): CalcInput {
  return {
    lines: items.map((item) => {
      const o = (
        typeof item === "object" && item !== null && !Array.isArray(item) ? item : {}
      ) as Record<string, unknown>;
      const kind = o.discount_kind;
      const discount = (
        kind === "none"
          ? { kind: "none" }
          : kind === "percent"
            ? { kind, bp: o.discount_value }
            : kind === "amount"
              ? { kind, clp: o.discount_value }
              : { kind }
      ) as Discount;
      return {
        quantityMilli: o.quantity_milli as number,
        unitPriceClp: o.unit_price_clp as number,
        taxTreatment: o.tax_treatment as "taxable",
        discount,
      };
    }),
    globalDiscount,
    taxRateBp: 1900,
  };
}

const goodItem = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    quantity_milli: "1000",
    unit_price_clp: "100",
    tax_treatment: '"taxable"',
    discount_kind: '"none"',
    discount_value: "0",
    ...over,
  };
  return `{${Object.entries(base)
    .map(([k, v]) => `"${k}": ${v}`)
    .join(", ")}}`;
};

// Casos fijos de forma del JSON (revisión del cálculo): SQL recibe el texto crudo; TypeScript, lo
// que daría JSON.parse del mismo texto.
const RAW_CASES: [string, string][] = [
  ["cantidad 1.0 (entero escrito con decimal)", `[${goodItem({ quantity_milli: "1.0" })}]`],
  ["cantidad 1e3 (notación científica)", `[${goodItem({ quantity_milli: "1e3" })}]`],
  ["precio -0", `[${goodItem({ unit_price_clp: "-0" })}]`],
  ["cantidad -0", `[${goodItem({ quantity_milli: "-0" })}]`],
  ["precio como texto", `[${goodItem({ unit_price_clp: '"100"' })}]`],
  [
    "descuento en porcentaje como texto",
    `[${goodItem({ discount_kind: '"percent"', discount_value: '"10"' })}]`,
  ],
  [
    "descuento en pesos como texto",
    `[${goodItem({ discount_kind: '"amount"', discount_value: '"10"' })}]`,
  ],
  ["líneas que no son objeto", `[1, "x", null, true, [1], ${goodItem()}]`],
  [
    "cantidad exactamente en el tope",
    `[${goodItem({ quantity_milli: "1000000000", unit_price_clp: "1000" })}]`,
  ],
  [
    "precio exactamente en el tope, cantidad mínima",
    `[${goodItem({ quantity_milli: "1", unit_price_clp: "1000000000000" })}]`,
  ],
  [
    "una unidad al precio tope: el total pasa el tope por el IVA",
    `[${goodItem({ unit_price_clp: "1000000000000" })}]`,
  ],
  [
    "descuento en pesos igual al bruto máximo",
    `[${goodItem({ unit_price_clp: "1000000000000", discount_kind: '"amount"', discount_value: "1000000000000" })}]`,
  ],
  [
    "descuento en pesos un peso sobre el bruto máximo",
    `[${goodItem({ unit_price_clp: "1000000000000", discount_kind: '"amount"', discount_value: "1000000000001" })}]`,
  ],
  [
    "none con valor distinto de 0: el valor se ignora, igual que en TypeScript",
    `[${goodItem({ discount_kind: '"none"', discount_value: "500" })}]`,
  ],
  ["none con valor texto", `[${goodItem({ discount_kind: '"none"', discount_value: '"x"' })}]`],
  ["cantidad fuera del tope por 1", `[${goodItem({ quantity_milli: "1000000001" })}]`],
];

describe("forma del JSON: SQL y TypeScript responden igual", () => {
  for (const [name, raw] of RAW_CASES) {
    it(name, async () => {
      const { rows } = await db.query<{ r: unknown }>(
        "select app.quote_calc_v1($1::jsonb, 'none', 0, 1900) as r",
        [raw],
      );
      const input = rawToInput(JSON.parse(raw) as unknown[]);
      expect(rows[0].r).toEqual(tsCalc(input));
    });
  }

  it("el resultado de los casos de tope es el esperado (no solo igual)", async () => {
    const run = async (raw: string) =>
      (
        await db.query<{ r: { ok: boolean; issues?: { code: string }[] } }>(
          "select app.quote_calc_v1($1::jsonb, 'none', 0, 1900) as r",
          [raw],
        )
      ).rows[0].r;
    expect((await run(`[${goodItem({ quantity_milli: "1.0" })}]`)).ok).toBe(true);
    expect((await run(`[${goodItem({ quantity_milli: "1e3" })}]`)).ok).toBe(true);
    expect((await run(`[${goodItem({ unit_price_clp: "-0" })}]`)).ok).toBe(true);
    expect((await run(`[${goodItem({ quantity_milli: "-0" })}]`)).issues?.[0].code).toBe(
      "invalid_quantity",
    );
    expect((await run(`[1, ${goodItem()}]`)).issues?.length).toBe(4);
    const top = await run(
      `[${goodItem({ unit_price_clp: "1000000000000", discount_kind: '"amount"', discount_value: "1000000000000" })}]`,
    );
    expect(top.ok).toBe(true);
    const over = await run(`[${goodItem({ unit_price_clp: "1000000000000" })}]`);
    expect(over.issues?.[0].code).toBe("total_too_large");
  });
});

describe("permisos de las funciones internas del cálculo", () => {
  const functions = [
    "app.quote_calc_v1(jsonb, text, bigint, integer)",
    "app.round_half_up_div(numeric, numeric)",
    "app.calc_jsonb_int_in_range(jsonb, numeric, numeric)",
    "app.vat_rate_bp()",
  ];
  for (const fn of functions) {
    it(`${fn} no es ejecutable por anon, authenticated ni PUBLIC`, async () => {
      const { rows } = await db.query<{ anon: boolean; auth: boolean; pub: boolean }>(
        `select has_function_privilege('anon', $1::regprocedure, 'execute') as anon,
                has_function_privilege('authenticated', $1::regprocedure, 'execute') as auth,
                exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub`,
        [fn],
      );
      expect(rows[0]).toEqual({ anon: false, auth: false, pub: false });
    });
  }
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
