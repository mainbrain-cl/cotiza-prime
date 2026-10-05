import { describe, expect, it } from "vitest";
import {
  formatPercentBp,
  formatQuantity,
  formatQuoteNumber,
  formatTaxRate,
  toBadgeStatus,
} from "./format";
import { parsePercent, parseQuantity } from "./parse";

describe("formatQuoteNumber", () => {
  it("la versión 1 no lleva sufijo y las siguientes sí", () => {
    expect(formatQuoteNumber("COT-2026-0043", 1)).toBe("COT-2026-0043");
    expect(formatQuoteNumber("COT-2026-0043", 2)).toBe("COT-2026-0043 v2");
  });
});

describe("formatQuantity", () => {
  it.each([
    [1000, "1"],
    [2500, "2,5"],
    [1, "0,001"],
    [333, "0,333"],
    [1500, "1,5"],
    [1_000_000_000, "1.000.000"],
    [1_234_567, "1.234,567"],
  ])("%i milésimas -> %s", (milli, text) => {
    expect(formatQuantity(milli)).toBe(text);
  });

  it("lo que se muestra se vuelve a leer igual (ida y vuelta)", () => {
    for (const milli of [1, 10, 100, 999, 1000, 2500, 12_345, 1_000_000_000]) {
      expect(parseQuantity(formatQuantity(milli))).toEqual({ ok: true, value: milli });
    }
  });

  it("rechaza valores que no son enteros seguros", () => {
    expect(() => formatQuantity(1.5)).toThrow(RangeError);
    expect(() => formatQuantity(-1)).toThrow(RangeError);
  });
});

describe("formatPercentBp", () => {
  it.each([
    [1000, "10"],
    [1250, "12,5"],
    [1, "0,01"],
    [10_000, "100"],
    [0, "0"],
  ])("%i pb -> %s", (bp, text) => {
    expect(formatPercentBp(bp)).toBe(text);
  });

  it("ida y vuelta con parsePercent", () => {
    for (const bp of [0, 1, 50, 1250, 9999, 10_000]) {
      expect(parsePercent(formatPercentBp(bp))).toEqual({ ok: true, value: bp });
    }
  });

  it("la etiqueta del IVA", () => {
    expect(formatTaxRate(1900)).toBe("19%");
    expect(formatTaxRate(1950)).toBe("19,5%");
  });
});

describe("toBadgeStatus", () => {
  it("traduce los dos estados que se llaman distinto en la base", () => {
    expect(toBadgeStatus("rejected_by_customer")).toBe("rejected_by_client");
    expect(toBadgeStatus("superseded")).toBe("replaced");
    expect(toBadgeStatus("draft")).toBe("draft");
  });
});
