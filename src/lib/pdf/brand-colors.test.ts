import { describe, expect, it } from "vitest";
import { contrastOnWhite, contrastRatio, MIN_TEXT_CONTRAST } from "@/lib/brand/colors";
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
    expect(brand.onPrimary).toBe("#000000");
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

  it("todo par texto/fondo llega a 4,5:1 en un abanico amplio de colores", () => {
    const fixed = [
      "#e10096",
      "#3c78c3",
      "#f4d35e",
      "#ffff00",
      "#808080",
      "#777777",
      "#ffffff",
      "#000000",
    ];
    const swept: string[] = [];
    const steps = [0, 51, 102, 153, 204, 255];
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const hex = (n: number) => n.toString(16).padStart(2, "0");
          swept.push(`#${hex(r)}${hex(g)}${hex(b)}`);
        }
      }
    }
    for (const color of [...fixed, ...swept]) {
      const brand = resolvePdfBrand(color, null);
      expect(
        contrastRatio(brand.primaryText, "#ffffff"),
        `texto sobre blanco ${color}`,
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(
        contrastRatio(brand.primaryText, brand.primaryTint),
        `texto sobre fondo suave ${color}`,
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(
        contrastRatio(brand.onPrimary, brand.primary),
        `texto sobre la banda ${color}`,
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(["#ffffff", "#000000"]).toContain(brand.onPrimary);
    }
  });
});
