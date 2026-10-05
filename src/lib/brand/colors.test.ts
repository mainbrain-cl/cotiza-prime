import { describe, expect, it } from "vitest";
import {
  contrastOnWhite,
  contrastRatio,
  DEFAULT_PRIMARY_COLOR,
  normalizeHexColor,
  readableTextOn,
  readsWellOnWhite,
} from "./colors";
import { brandColorsSchema } from "./schemas";

describe("normalizeHexColor", () => {
  it.each([
    ["#2B54E0", "#2b54e0"],
    ["2b54e0", "#2b54e0"],
    ["  #ABC ", "#aabbcc"],
    ["f0f", "#ff00ff"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeHexColor(input)).toBe(expected);
  });

  it.each(["", "#12", "#12345", "#1234567", "rojo", "#gggggg", "rgb(0,0,0)", "#2b54e0;x"])(
    "rechaza %j",
    (input) => {
      expect(normalizeHexColor(input)).toBeNull();
    },
  );
});

describe("contraste WCAG", () => {
  it("negro sobre blanco es 21:1 y blanco sobre blanco es 1:1", () => {
    expect(contrastOnWhite("#000000")).toBeCloseTo(21, 5);
    expect(contrastOnWhite("#ffffff")).toBeCloseTo(1, 5);
  });

  it("coincide con valores de referencia publicados", () => {
    // #767676 sobre blanco es el gris más claro que pasa AA (4,54:1).
    expect(contrastOnWhite("#767676")).toBeCloseTo(4.54, 1);
    expect(contrastRatio("#ffffff", "#767676")).toBeCloseTo(
      contrastRatio("#767676", "#ffffff"),
      10,
    );
  });

  it("advierte con amarillo y gris claro, no con azul oscuro ni con el color de Cotiza Prime", () => {
    expect(readsWellOnWhite("#ffeb3b")).toBe(false);
    expect(readsWellOnWhite("#cccccc")).toBe(false);
    expect(readsWellOnWhite("#777777")).toBe(false);
    expect(readsWellOnWhite("#595959")).toBe(true);
    expect(readsWellOnWhite("#0b2a6f")).toBe(true);
    expect(readsWellOnWhite(DEFAULT_PRIMARY_COLOR)).toBe(true);
  });

  it("elige texto blanco sobre fondos oscuros y oscuro sobre fondos claros", () => {
    expect(readableTextOn("#0b2a6f")).toBe("#ffffff");
    expect(readableTextOn("#ffeb3b")).not.toBe("#ffffff");
  });
});

describe("brandColorsSchema", () => {
  it("normaliza ambos colores", () => {
    const parsed = brandColorsSchema.parse({ primaryColor: "#ABC", secondaryColor: "0F1729" });
    expect(parsed).toEqual({ primaryColor: "#aabbcc", secondaryColor: "#0f1729" });
  });

  it("explica qué color está mal", () => {
    const result = brandColorsSchema.safeParse({ primaryColor: "azul", secondaryColor: "#000000" });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("color principal no es válido");
  });
});
