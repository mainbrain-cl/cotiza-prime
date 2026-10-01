import { describe, expect, it } from "vitest";
import {
  computeCheckDigit,
  formatRut,
  generateRut,
  isValidRut,
  normalizeRut,
  parseRut,
} from "./rut";

describe("normalizeRut", () => {
  it.each([
    ["76.086.428-5", "76086428-5"],
    ["760864285", "76086428-5"],
    [" 76 086 428-5 ", "76086428-5"],
    ["0076086428-5", "76086428-5"],
    ["6-k", "6-K"],
  ])("normaliza %s", (input, expected) => {
    expect(normalizeRut(input)).toBe(expected);
  });

  it.each(["", "abc", "1", "0-0", "12a45678-5", null, undefined])(
    "devuelve null para %s",
    (input) => {
      expect(normalizeRut(input)).toBeNull();
    },
  );
});

describe("isValidRut y parseRut", () => {
  it.each(["76086428-5", "12345678-5", "11111111-1", "1-9", "6-K"])("acepta %s", (rut) => {
    expect(isValidRut(rut)).toBe(true);
    expect(parseRut(rut)).toBe(rut);
  });

  it("parseRut acepta formatos con puntos y K minúscula", () => {
    expect(parseRut("76.086.428-5")).toBe("76086428-5");
    expect(parseRut("6-k")).toBe("6-K");
  });

  it("rechaza dígito verificador equivocado", () => {
    expect(parseRut("76086428-4")).toBeNull();
  });

  it("isValidRut exige la forma canónica", () => {
    expect(isValidRut("76.086.428-5")).toBe(false);
    expect(isValidRut("760864285")).toBe(false);
    expect(isValidRut("012345678-5")).toBe(false);
    expect(isValidRut(null)).toBe(false);
  });
});

describe("computeCheckDigit", () => {
  it("cubre los resultados 0 y K", () => {
    const find = (digit: string) => {
      for (let i = 1; ; i++) if (computeCheckDigit(String(i)) === digit) return i;
    };
    expect(computeCheckDigit(String(find("0")))).toBe("0");
    expect(computeCheckDigit(String(find("K")))).toBe("K");
  });
});

describe("formatRut", () => {
  it("da formato de pantalla", () => {
    expect(formatRut("760864285")).toBe("76.086.428-5");
    expect(formatRut("6-K")).toBe("6-K");
    expect(formatRut("11111111-1")).toBe("11.111.111-1");
  });

  it("devuelve null si no es válido", () => {
    expect(formatRut("76086428-4")).toBeNull();
  });
});

describe("generateRut", () => {
  it("genera RUT válidos", () => {
    for (let i = 0; i < 200; i++) expect(isValidRut(generateRut())).toBe(true);
  });

  it("es repetible con un generador fijo", () => {
    expect(generateRut(() => 0.5)).toBe(generateRut(() => 0.5));
  });
});
