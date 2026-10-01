import { describe, expect, it } from "vitest";
import { computeCheckDigit, formatRut, isValidRut, normalizeRut } from ".";

describe("RUT", () => {
  it("normaliza puntos, guion y mayúsculas", () => {
    expect(normalizeRut("76.123.456-0")).toBe("76123456-0");
    expect(normalizeRut(" 12.345.678-5 ")).toBe("12345678-5");
    expect(normalizeRut("0012345678-5")).toBe("12345678-5");
    expect(normalizeRut("1.000.005-k")).toBe("1000005-K");
  });

  it("rechaza lo que no tiene forma de RUT", () => {
    for (const bad of ["", "abc", "-", "K", "12.345.678-", "1234567890123-4", "12a45678-5"]) {
      expect(isValidRut(bad)).toBe(false);
    }
  });

  it("calcula el dígito verificador (incluye 0 y K)", () => {
    expect(computeCheckDigit("12345678")).toBe("5");
    expect(computeCheckDigit("76123456")).toBe("0");
    expect(computeCheckDigit("1000005")).toBe("K");
    expect(computeCheckDigit("12345678")).toBe("5");
  });

  it("valida RUT con dígito correcto y rechaza los incorrectos", () => {
    expect(isValidRut("76.123.456-0")).toBe(true);
    expect(isValidRut("12.345.678-5")).toBe(true);
    expect(isValidRut("1.000.005-K")).toBe(true);
    expect(isValidRut("76.123.456-9")).toBe(false);
    expect(isValidRut("12.345.678-9")).toBe(false);
    expect(isValidRut("123456789012-3")).toBe(false);
  });

  it("da formato con puntos y guion", () => {
    expect(formatRut("761234560")).toBe("76.123.456-0");
    expect(formatRut("76123456-0")).toBe("76.123.456-0");
    expect(formatRut("1000005k")).toBe("1.000.005-K");
    expect(formatRut("hola")).toBe("hola");
  });
});
