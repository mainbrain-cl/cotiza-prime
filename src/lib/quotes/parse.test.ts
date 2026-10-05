import { describe, expect, it } from "vitest";
import { parsePercent, parseQuantity } from "./parse";

const USE_COMMA = { ok: false, message: "Usa coma para decimales: 2,5" };

describe("parseQuantity", () => {
  it("lee enteros y decimales con coma", () => {
    expect(parseQuantity("2")).toEqual({ ok: true, value: 2000 });
    expect(parseQuantity("2,5")).toEqual({ ok: true, value: 2500 });
    expect(parseQuantity("0,333")).toEqual({ ok: true, value: 333 });
    expect(parseQuantity("0,001")).toEqual({ ok: true, value: 1 });
    expect(parseQuantity(" 2,50 ")).toEqual({ ok: true, value: 2500 });
  });

  it("acepta punto solo como miles en grupos de 3", () => {
    expect(parseQuantity("1.000,25")).toEqual({ ok: true, value: 1_000_250 });
    expect(parseQuantity("1.000")).toEqual({ ok: true, value: 1_000_000 });
    expect(parseQuantity("1.000.000")).toEqual({ ok: true, value: 1_000_000_000 });
  });

  it("rechaza el punto decimal con un mensaje que enseña la coma", () => {
    expect(parseQuantity("2.5")).toEqual(USE_COMMA);
    expect(parseQuantity("10.25")).toEqual(USE_COMMA);
  });

  it("rechaza más de 3 decimales", () => {
    expect(parseQuantity("0,0001")).toEqual({ ok: false, message: "Máximo 3 decimales." });
  });

  it("rechaza vacío, negativo, cero, basura y excesos", () => {
    for (const text of ["", "   ", "-1", "0", "0,000", "abc", "1,2,3", "1.0.0", "1,a", "2.50,5"]) {
      expect(parseQuantity(text).ok, text).toBe(false);
    }
    expect(parseQuantity("2%").ok).toBe(false);
    expect(parseQuantity("1.000.001").ok).toBe(false);
    expect(parseQuantity("1.000.000").ok).toBe(true);
  });
});

describe("parsePercent", () => {
  it("lee a puntos base", () => {
    expect(parsePercent("12,5")).toEqual({ ok: true, value: 1250 });
    expect(parsePercent("10")).toEqual({ ok: true, value: 1000 });
    expect(parsePercent("10%")).toEqual({ ok: true, value: 1000 });
    expect(parsePercent("0")).toEqual({ ok: true, value: 0 });
    expect(parsePercent("0,01")).toEqual({ ok: true, value: 1 });
    expect(parsePercent("100")).toEqual({ ok: true, value: 10_000 });
    expect(parsePercent("100,00")).toEqual({ ok: true, value: 10_000 });
  });

  it("rechaza más de 100%, más de 2 decimales, punto decimal, vacío y negativo", () => {
    expect(parsePercent("100,01").ok).toBe(false);
    expect(parsePercent("101").ok).toBe(false);
    expect(parsePercent("12,555")).toEqual({ ok: false, message: "Máximo 2 decimales." });
    expect(parsePercent("12.5")).toEqual(USE_COMMA);
    expect(parsePercent("").ok).toBe(false);
    expect(parsePercent("-5").ok).toBe(false);
    expect(parsePercent("x").ok).toBe(false);
  });
});
