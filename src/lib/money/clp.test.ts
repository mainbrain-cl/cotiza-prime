import { describe, expect, it } from "vitest";
import { formatClp, MAX_CLP, parseClp } from "./clp";

describe("formatClp", () => {
  it("usa punto de miles y sin decimales", () => {
    expect(formatClp(0)).toBe("$0");
    expect(formatClp(999)).toBe("$999");
    expect(formatClp(1000)).toBe("$1.000");
    expect(formatClp(1250000)).toBe("$1.250.000");
    expect(formatClp(12345678)).toBe("$12.345.678");
  });
  it("rechaza decimales", () => {
    expect(() => formatClp(10.5)).toThrow(RangeError);
    expect(() => formatClp(Number.NaN)).toThrow(RangeError);
  });
});

describe("parseClp", () => {
  it.each([
    ["1250000", 1250000],
    ["1.250.000", 1250000],
    ["$1.250.000", 1250000],
    [" $ 15.000 ", 15000],
    ["0", 0],
    ["999", 999],
  ])("lee %s", (input, value) => {
    expect(parseClp(input)).toEqual({ ok: true, value });
  });
  it("rechaza vacío", () => {
    expect(parseClp("  ")).toEqual({ ok: false, reason: "empty" });
  });
  it("rechaza negativos", () => {
    expect(parseClp("-5000")).toEqual({ ok: false, reason: "negative" });
  });
  it.each(["1250,5", "1.25", "1250.5", "10,00"])("rechaza el decimal %s", (input) => {
    expect(parseClp(input)).toEqual({ ok: false, reason: "decimal" });
  });
  it.each(["abc", "12a", "1.2.3", "1..000", "12.34.567"])("rechaza lo ilegible %s", (input) => {
    expect(parseClp(input)).toEqual({ ok: false, reason: "invalid" });
  });
  it("rechaza montos desmedidos", () => {
    expect(parseClp(String(MAX_CLP + 1))).toEqual({ ok: false, reason: "too_large" });
    expect(parseClp(String(MAX_CLP))).toEqual({ ok: true, value: MAX_CLP });
  });
});
