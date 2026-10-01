import { describe, expect, it } from "vitest";
import {
  businessYear,
  formatQuoteNumber,
  minimumNextNumber,
  numberingScope,
  tooLowMessage,
} from "./format";
import { numberingSchema } from "./schemas";

describe("formatQuoteNumber", () => {
  it("anual lleva el año y rellena con ceros", () => {
    expect(
      formatQuoteNumber({ prefix: "COT", mode: "yearly", padWidth: 4, year: 2026, sequence: 43 }),
    ).toBe("COT-2026-0043");
  });
  it("corrido no lleva año", () => {
    expect(
      formatQuoteNumber({
        prefix: "PRES",
        mode: "continuous",
        padWidth: 4,
        year: 2026,
        sequence: 2043,
      }),
    ).toBe("PRES-2043");
  });
  it("un número más largo que el ancho no se corta", () => {
    expect(
      formatQuoteNumber({
        prefix: "COT",
        mode: "continuous",
        padWidth: 4,
        year: 2026,
        sequence: 12345,
      }),
    ).toBe("COT-12345");
  });
});

describe("reglas", () => {
  it("el mínimo es el mayor de los últimos más uno", () => {
    expect(minimumNextNumber(43, 0)).toBe(44);
    expect(minimumNextNumber(0, 2043)).toBe(2044);
    expect(minimumNextNumber(0, 0)).toBe(1);
  });
  it("el mensaje dice el mínimo", () => {
    expect(tooLowMessage(44)).toBe("El próximo número no puede ser menor que 44.");
  });
  it("el alcance depende del formato", () => {
    expect(numberingScope("yearly", 2026)).toBe("Y2026");
    expect(numberingScope("continuous", 2026)).toBe("continuous");
  });
  it("el año usa la hora de Chile", () => {
    expect(businessYear(new Date("2027-01-01T01:00:00Z"))).toBe(2026);
    expect(businessYear(new Date("2027-01-01T04:00:00Z"))).toBe(2027);
  });
});

describe("numberingSchema", () => {
  const ok = { prefix: "ppto", mode: "yearly", startNumber: "2001" };
  it("normaliza el prefijo a mayúsculas y el número a entero", () => {
    expect(numberingSchema.parse(ok)).toEqual({
      prefix: "PPTO",
      mode: "yearly",
      startNumber: 2001,
    });
  });
  it("rechaza prefijos inválidos", () => {
    for (const prefix of ["", "CO T", "COT-", "ABCDEFGHI", "ÑU"]) {
      expect(numberingSchema.safeParse({ ...ok, prefix }).success).toBe(false);
    }
  });
  it("rechaza formatos y números inválidos", () => {
    expect(numberingSchema.safeParse({ ...ok, mode: "weekly" }).success).toBe(false);
    for (const startNumber of ["", "0", "-3", "1,5", "12a", "100000000"]) {
      expect(numberingSchema.safeParse({ ...ok, startNumber }).success).toBe(false);
    }
  });
});
