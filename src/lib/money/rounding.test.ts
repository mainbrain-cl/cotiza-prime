import { describe, expect, it } from "vitest";
import { roundHalfUpDiv } from "./rounding";

const big = (n: number) => BigInt(n);

describe("roundHalfUpDiv", () => {
  it("sube cuando queda justo en la mitad", () => {
    expect(roundHalfUpDiv(big(1), big(2))).toBe(big(1)); // 0,5 -> 1
    expect(roundHalfUpDiv(big(3), big(2))).toBe(big(2)); // 1,5 -> 2
    expect(roundHalfUpDiv(big(5), big(2))).toBe(big(3)); // 2,5 -> 3
    expect(roundHalfUpDiv(big(1005), big(10))).toBe(big(101)); // 100,5 -> 101
  });

  it("baja bajo la mitad y sube sobre la mitad", () => {
    expect(roundHalfUpDiv(big(499), big(1000))).toBe(big(0)); // 0,499
    expect(roundHalfUpDiv(big(501), big(1000))).toBe(big(1)); // 0,501
    expect(roundHalfUpDiv(big(49), big(100))).toBe(big(0));
    expect(roundHalfUpDiv(big(51), big(100))).toBe(big(1));
  });

  it("deja igual lo que ya es entero", () => {
    expect(roundHalfUpDiv(big(0), big(1000))).toBe(big(0));
    expect(roundHalfUpDiv(big(5000), big(1000))).toBe(big(5));
    expect(roundHalfUpDiv(big(7), big(1))).toBe(big(7));
  });

  it("es exacto con números mucho más grandes que un entero seguro", () => {
    const n = BigInt("1000000000000000000000"); // 10^21
    expect(roundHalfUpDiv(n, big(1000))).toBe(BigInt("1000000000000000000"));
    expect(roundHalfUpDiv(n + big(500), big(1000))).toBe(BigInt("1000000000000000001"));
    expect(roundHalfUpDiv(n + big(499), big(1000))).toBe(BigInt("1000000000000000000"));
  });

  it("rechaza numerador negativo y denominador no positivo", () => {
    expect(() => roundHalfUpDiv(big(-1), big(2))).toThrow(RangeError);
    expect(() => roundHalfUpDiv(big(1), big(0))).toThrow(RangeError);
    expect(() => roundHalfUpDiv(big(1), big(-2))).toThrow(RangeError);
  });
});
