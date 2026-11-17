/**
 * La tabla de casos de las reglas de precio y descuento (docs/arquitectura/h-041-precios-bloqueados.md §2.2 y §4). La comparten la
 * prueba unitaria (`line-rules.test.ts`) y la de paridad con la base de datos (`tests/db/line-rules-parity.test.ts`): ahí cada caso
 * se calcula con `app.line_rule_issues` y tiene que dar lo mismo que con `line-rules.ts`. Sin dependencias: la leen Vitest y Playwright.
 */
import type { LineRulesInput, RuleLine } from "./line-rules";

export type LineRuleCase = {
  name: string;
  input: LineRulesInput;
  /** Los problemas tal como los escribe la base, en su orden (`price_locked@0`, `global_discount_over_cap`…). */
  issues: string[];
  /** Los índices de las líneas con precio bloqueado cotizadas a otro precio (lo que anota quien puede saltarse el candado). */
  overrides: number[];
};

/** Una línea del catálogo de $10.000, sin candado, sin descuento. */
export function ruleLine(over: Partial<RuleLine> = {}): RuleLine {
  return {
    priceLocked: false,
    catalogUnitPriceClp: 10_000,
    unitPriceClp: 10_000,
    discount: { kind: "none" },
    grossClp: 10_000,
    ...over,
  };
}

const LOCKED = { priceLocked: true } as const;
const free = (over: Partial<RuleLine> = {}) => ruleLine({ catalogUnitPriceClp: null, ...over });
const input = (over: Partial<LineRulesInput>): LineRulesInput => ({
  lines: [],
  global: null,
  maxDiscountBp: null,
  canOverride: false,
  ...over,
});

export const LINE_RULE_CASES: readonly LineRuleCase[] = [
  {
    name: "sin líneas ni tope: nada que decir",
    input: input({}),
    issues: [],
    overrides: [],
  },
  {
    name: "precio bloqueado igual al del catálogo: pasa",
    input: input({ lines: [ruleLine(LOCKED)] }),
    issues: [],
    overrides: [],
  },
  {
    name: "precio bloqueado más bajo: price_locked",
    input: input({ lines: [ruleLine({ ...LOCKED, unitPriceClp: 8_000, grossClp: 8_000 })] }),
    issues: ["price_locked@0"],
    overrides: [0],
  },
  {
    name: "precio bloqueado más alto: también price_locked (subirlo tampoco vale)",
    input: input({ lines: [ruleLine({ ...LOCKED, unitPriceClp: 12_000, grossClp: 12_000 })] }),
    issues: ["price_locked@0"],
    overrides: [0],
  },
  {
    name: "servicio sin candado con otro precio: pasa",
    input: input({ lines: [ruleLine({ unitPriceClp: 8_000, grossClp: 8_000 })] }),
    issues: [],
    overrides: [],
  },
  {
    name: "línea libre (sin catálogo): pasa aunque el candado diga que sí",
    input: input({ lines: [free({ ...LOCKED, unitPriceClp: 1, grossClp: 1 })] }),
    issues: [],
    overrides: [],
  },
  {
    name: "quien puede saltarse el candado: sin problemas, pero queda anotada la línea",
    input: input({
      lines: [ruleLine({ ...LOCKED, unitPriceClp: 8_000, grossClp: 8_000 })],
      canOverride: true,
    }),
    issues: [],
    overrides: [0],
  },
  {
    name: "quien puede saltarse la regla también se salta el tope",
    input: input({
      lines: [ruleLine({ discount: { kind: "percent", bp: 5_000 } })],
      global: { discount: { kind: "percent", bp: 5_000 }, baseClp: 5_000 },
      maxDiscountBp: 1_000,
      canOverride: true,
    }),
    issues: [],
    overrides: [],
  },
  {
    name: "precio bloqueado con descuento dentro del tope: pasa (el candado no bloquea el descuento)",
    input: input({
      lines: [ruleLine({ ...LOCKED, discount: { kind: "percent", bp: 1_000 }, grossClp: 10_000 })],
      maxDiscountBp: 1_000,
    }),
    issues: [],
    overrides: [],
  },
  {
    name: "descuento de 10,00 % con tope 10 %: pasa",
    input: input({
      lines: [ruleLine({ discount: { kind: "percent", bp: 1_000 } })],
      maxDiscountBp: 1_000,
    }),
    issues: [],
    overrides: [],
  },
  {
    name: "descuento de 10,01 % con tope 10 %: discount_over_cap",
    input: input({
      lines: [ruleLine({ discount: { kind: "percent", bp: 1_001 } })],
      maxDiscountBp: 1_000,
    }),
    issues: ["discount_over_cap@0"],
    overrides: [],
  },
  {
    name: "descuento en pesos de $1.000 sobre $10.000 con tope 10 %: pasa",
    input: input({
      lines: [ruleLine({ discount: { kind: "amount", clp: 1_000 } })],
      maxDiscountBp: 1_000,
    }),
    issues: [],
    overrides: [],
  },
  {
    name: "descuento en pesos de $1.001 sobre $10.000 con tope 10 %: discount_over_cap",
    input: input({
      lines: [ruleLine({ discount: { kind: "amount", clp: 1_001 } })],
      maxDiscountBp: 1_000,
    }),
    issues: ["discount_over_cap@0"],
    overrides: [],
  },
  {
    name: "bruto $1.005 al 10 %: el tope en pesos es $101 (mitad hacia arriba): $101 pasa",
    input: input({
      lines: [
        ruleLine({ discount: { kind: "amount", clp: 101 }, unitPriceClp: 1_005, grossClp: 1_005 }),
      ],
      maxDiscountBp: 1_000,
    }),
    issues: [],
    overrides: [],
  },
  {
    name: "bruto $1.005 al 10 %: $102 ya pasa del tope de $101",
    input: input({
      lines: [
        ruleLine({ discount: { kind: "amount", clp: 102 }, unitPriceClp: 1_005, grossClp: 1_005 }),
      ],
      maxDiscountBp: 1_000,
    }),
    issues: ["discount_over_cap@0"],
    overrides: [],
  },
  {
    name: "tope 0: cualquier descuento en porcentaje se rechaza",
    input: input({
      lines: [ruleLine({ discount: { kind: "percent", bp: 1 } })],
      maxDiscountBp: 0,
    }),
    issues: ["discount_over_cap@0"],
    overrides: [],
  },
  {
    name: "tope 0: cualquier descuento en pesos se rechaza",
    input: input({
      lines: [ruleLine({ discount: { kind: "amount", clp: 1 } })],
      maxDiscountBp: 0,
    }),
    issues: ["discount_over_cap@0"],
    overrides: [],
  },
  {
    name: "tope 0 y sin descuento: pasa",
    input: input({ lines: [ruleLine()], maxDiscountBp: 0 }),
    issues: [],
    overrides: [],
  },
  {
    name: "sin tope (vacío): cualquier descuento pasa",
    input: input({
      lines: [ruleLine({ discount: { kind: "percent", bp: 9_999 } })],
      maxDiscountBp: null,
    }),
    issues: [],
    overrides: [],
  },
  {
    name: "descuento general de 10,01 % con tope 10 %: global_discount_over_cap",
    input: input({
      global: { discount: { kind: "percent", bp: 1_001 }, baseClp: 50_000 },
      maxDiscountBp: 1_000,
    }),
    issues: ["global_discount_over_cap"],
    overrides: [],
  },
  {
    name: "descuento general de 10,00 % con tope 10 %: pasa",
    input: input({
      global: { discount: { kind: "percent", bp: 1_000 }, baseClp: 50_000 },
      maxDiscountBp: 1_000,
    }),
    issues: [],
    overrides: [],
  },
  {
    name: "descuento general en pesos: se mide contra el subtotal (tope $5.000 sobre $50.000)",
    input: input({
      global: { discount: { kind: "amount", clp: 5_001 }, baseClp: 50_000 },
      maxDiscountBp: 1_000,
    }),
    issues: ["global_discount_over_cap"],
    overrides: [],
  },
  {
    name: "el tope limita cada descuento por separado: línea de 10 % y general de 10 % (19 % sumado) pasan",
    input: input({
      lines: [ruleLine({ discount: { kind: "percent", bp: 1_000 } })],
      global: { discount: { kind: "percent", bp: 1_000 }, baseClp: 9_000 },
      maxDiscountBp: 1_000,
    }),
    issues: [],
    overrides: [],
  },
  {
    name: "línea libre con descuento sobre el tope: también se rechaza (el tope vale para todas las líneas)",
    input: input({
      lines: [free({ discount: { kind: "percent", bp: 2_000 } })],
      maxDiscountBp: 1_000,
    }),
    issues: ["discount_over_cap@0"],
    overrides: [],
  },
  {
    name: "varios problemas: el orden es por línea (candado, luego descuento) y al final el general",
    input: input({
      lines: [
        ruleLine({ ...LOCKED, unitPriceClp: 9_000, grossClp: 9_000 }),
        ruleLine(),
        ruleLine({
          ...LOCKED,
          unitPriceClp: 11_000,
          grossClp: 11_000,
          discount: { kind: "percent", bp: 5_000 },
        }),
      ],
      global: { discount: { kind: "amount", clp: 60_000 }, baseClp: 100_000 },
      maxDiscountBp: 1_000,
    }),
    issues: ["price_locked@0", "price_locked@2", "discount_over_cap@2", "global_discount_over_cap"],
    overrides: [0, 2],
  },
  {
    name: "montos enormes (cantidad × precio sobre 2^53): el tope en pesos no pierde exactitud",
    input: input({
      lines: [
        ruleLine({
          unitPriceClp: 999_999_999_999,
          catalogUnitPriceClp: 999_999_999_999,
          grossClp: 999_999_999_999,
          discount: { kind: "amount", clp: 99_990_000_000 },
        }),
      ],
      maxDiscountBp: 1_000,
    }),
    // 10 % de 999.999.999.999 = 99.999.999.999,9 → 100.000.000.000 (mitad hacia arriba)
    issues: [],
    overrides: [],
  },
  {
    name: "montos enormes: un peso sobre el tope se rechaza",
    input: input({
      lines: [
        ruleLine({
          unitPriceClp: 999_999_999_999,
          catalogUnitPriceClp: 999_999_999_999,
          grossClp: 999_999_999_999,
          discount: { kind: "amount", clp: 100_000_000_001 },
        }),
      ],
      maxDiscountBp: 1_000,
    }),
    issues: ["discount_over_cap@0"],
    overrides: [],
  },
];
