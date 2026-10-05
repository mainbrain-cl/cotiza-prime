import { describe, expect, it } from "vitest";
import { contrastOnWhite, MIN_TEXT_CONTRAST } from "@/lib/brand/colors";
import { resolvePdfBrand } from "./brand-colors";

describe("resolvePdfBrand", () => {
  it("un color oscuro se usa tal cual y el texto sobre la banda es blanco", () => {
    const brand = resolvePdfBrand("#0e4c7a", "#e8a33d");
    expect(brand.primary).toBe("#0e4c7a");
    expect(brand.primaryText).toBe("#0e4c7a");
    expect(brand.onPrimary).toBe("#ffffff");
    expect(brand.secondary).toBe("#e8a33d");
  });

  it("un color claro oscurece los textos hasta 4,5:1 y el texto sobre la banda pasa a oscuro", () => {
    const brand = resolvePdfBrand("#f4d35e", "#2d3142");
    expect(brand.primary).toBe("#f4d35e");
    expect(contrastOnWhite(brand.primaryText)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(brand.primaryText).not.toBe("#f4d35e");
    expect(brand.onPrimary).toBe("#111111");
  });

  it("incluso el blanco puro termina con un texto legible", () => {
    const brand = resolvePdfBrand("#ffffff", null);
    expect(contrastOnWhite(brand.primaryText)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it("sin colores, o con colores inválidos, usa los de partida", () => {
    expect(resolvePdfBrand(null, null).primary).toBe("#2b54e0");
    expect(resolvePdfBrand("rojo", "xx").primary).toBe("#2b54e0");
  });

  it("el fondo suave es casi blanco", () => {
    expect(contrastOnWhite(resolvePdfBrand("#0e4c7a", null).primaryTint)).toBeLessThan(1.2);
  });
});
