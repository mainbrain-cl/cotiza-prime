import { describe, expect, it } from "vitest";
import { LINE_RULE_CASES, ruleLine } from "./line-rules-cases";
import {
  MAX_DISCOUNT_BP_LIMIT,
  formatLineRuleIssue,
  isValidMaxDiscountBp,
  lineRuleFieldErrors,
  lineRuleIssues,
  lockedPriceOverrides,
  maxDiscountClp,
  parseLineRulesError,
} from "./line-rules";

describe("la tabla de casos de las reglas de precio y descuento", () => {
  it("tiene casos y nombres distintos", () => {
    expect(LINE_RULE_CASES.length).toBeGreaterThanOrEqual(25);
    expect(new Set(LINE_RULE_CASES.map((c) => c.name)).size).toBe(LINE_RULE_CASES.length);
  });

  for (const c of LINE_RULE_CASES) {
    it(c.name, () => {
      expect(lineRuleIssues(c.input).map(formatLineRuleIssue)).toEqual(c.issues);
      // Las líneas anotadas no dependen de si la persona puede saltarse la regla ni del tope.
      expect(lockedPriceOverrides(c.input.lines)).toEqual(c.overrides);
    });
  }
});

describe("el tope en pesos", () => {
  it("se redondea mitad hacia arriba: $1.005 al 10 % son $101; $1.004 al 10 % son $100", () => {
    expect(maxDiscountClp(1_005, 1_000)).toBe(BigInt(101));
    expect(maxDiscountClp(1_004, 1_000)).toBe(BigInt(100));
  });

  it("con tope 0 es 0, y con 99,99 % de $10.000 son $9.999", () => {
    expect(maxDiscountClp(50_000, 0)).toBe(BigInt(0));
    expect(maxDiscountClp(10_000, 9_999)).toBe(BigInt(9_999));
  });

  it("no pierde exactitud sobre 2^53", () => {
    expect(maxDiscountClp(999_999_999_999, 1_000)).toBe(BigInt(100_000_000_000));
  });
});

describe("quién queda sujeto", () => {
  const broken = ruleLine({ priceLocked: true, unitPriceClp: 9_000, grossClp: 9_000 });

  it("quien se salta la regla no ve problemas, aunque haya candado, tope y descuento general", () => {
    expect(
      lineRuleIssues({
        lines: [broken],
        global: { discount: { kind: "percent", bp: 9_000 }, baseClp: 10_000 },
        maxDiscountBp: 0,
        canOverride: true,
      }),
    ).toEqual([]);
  });

  it("sin descuento general (`null`) solo se miran las líneas", () => {
    expect(
      lineRuleIssues({ lines: [broken], global: null, maxDiscountBp: 0, canOverride: false }),
    ).toEqual([{ code: "price_locked", lineIndex: 0 }]);
  });

  it("una línea libre no tiene candado aunque `priceLocked` venga encendido", () => {
    const freeLine = ruleLine({
      priceLocked: true,
      catalogUnitPriceClp: null,
      unitPriceClp: 1,
      grossClp: 1,
    });
    expect(lockedPriceOverrides([freeLine])).toEqual([]);
  });
});

describe("leer el mensaje de error de la base", () => {
  it("lee varios problemas, con y sin línea, y el que pone el gancho de H-042", () => {
    expect(
      parseLineRulesError(
        "line_rules_invalid: price_locked@0,discount_over_cap@2,global_discount_over_cap,catalog_item_not_allowed@1",
      ),
    ).toEqual([
      { code: "price_locked", lineIndex: 0 },
      { code: "discount_over_cap", lineIndex: 2 },
      { code: "global_discount_over_cap", lineIndex: null },
      { code: "catalog_item_not_allowed", lineIndex: 1 },
    ]);
  });

  it("lo que formatea es lo que lee", () => {
    const text = "price_locked@3,global_discount_over_cap";
    const issues = parseLineRulesError(`line_rules_invalid: ${text}`);
    expect(issues?.map(formatLineRuleIssue).join(",")).toBe(text);
  });

  it("un mensaje de otra cosa, vacío o sin texto da null", () => {
    expect(parseLineRulesError("calc_invalid: invalid_price@0")).toBeNull();
    expect(parseLineRulesError("")).toBeNull();
    expect(parseLineRulesError(null)).toBeNull();
    expect(parseLineRulesError(undefined)).toBeNull();
  });

  it("un código que esta versión no conoce queda como `unknown` y cae en `form`", () => {
    const issues = parseLineRulesError("line_rules_invalid: algo_nuevo@1,price_locked@0");
    expect(issues).toEqual([
      { code: "unknown", lineIndex: null },
      { code: "price_locked", lineIndex: 0 },
    ]);
    expect(Object.keys(lineRuleFieldErrors(issues ?? [])).sort()).toEqual([
      "form",
      "items.0.price",
    ]);
  });

  it("el mensaje puede venir envuelto en otro texto de la API", () => {
    expect(parseLineRulesError("Error: line_rules_invalid: discount_over_cap@4")).toEqual([
      { code: "discount_over_cap", lineIndex: 4 },
    ]);
  });
});

describe("errores por campo", () => {
  it("cada problema va a la llave del editor", () => {
    const errors = lineRuleFieldErrors(
      [
        { code: "price_locked", lineIndex: 0 },
        { code: "discount_over_cap", lineIndex: 2 },
        { code: "global_discount_over_cap", lineIndex: null },
        { code: "catalog_item_not_allowed", lineIndex: 1 },
      ],
      { maxDiscountBp: 1_000 },
    );
    expect(Object.keys(errors).sort()).toEqual([
      "globalDiscount",
      "items.0.price",
      "items.1.name",
      "items.2.discount",
    ]);
    expect(errors["items.2.discount"]).toContain("10 %");
    expect(errors["items.0.price"]).toMatch(/bloqueado/);
  });

  it("con tope 0 dice que no se permiten descuentos; con 12,5 % lo dice con coma", () => {
    const zero = lineRuleFieldErrors([{ code: "discount_over_cap", lineIndex: 0 }], {
      maxDiscountBp: 0,
    });
    expect(zero["items.0.discount"]).toBe("Tu organización no permite descuentos.");
    const decimals = lineRuleFieldErrors([{ code: "global_discount_over_cap", lineIndex: null }], {
      maxDiscountBp: 1_250,
    });
    expect(decimals.globalDiscount).toContain("12,5 %");
  });

  it("un problema con una forma que no corresponde (sin línea donde debía haberla) cae en `form`", () => {
    expect(Object.keys(lineRuleFieldErrors([{ code: "price_locked", lineIndex: null }]))).toEqual([
      "form",
    ]);
    expect(
      Object.keys(lineRuleFieldErrors([{ code: "global_discount_over_cap", lineIndex: 2 }])),
    ).toEqual(["form"]);
  });
});

describe("el tope que se puede fijar", () => {
  it("vacío o de 0 a 9.999", () => {
    expect(isValidMaxDiscountBp(null)).toBe(true);
    expect(isValidMaxDiscountBp(0)).toBe(true);
    expect(isValidMaxDiscountBp(MAX_DISCOUNT_BP_LIMIT)).toBe(true);
    expect(isValidMaxDiscountBp(MAX_DISCOUNT_BP_LIMIT + 1)).toBe(false);
    expect(isValidMaxDiscountBp(-1)).toBe(false);
    expect(isValidMaxDiscountBp(10.5)).toBe(false);
    expect(isValidMaxDiscountBp("1000")).toBe(false);
    expect(isValidMaxDiscountBp(undefined)).toBe(false);
  });
});
