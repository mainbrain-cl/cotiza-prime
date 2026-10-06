import { describe, expect, it } from "vitest";
import { DEFAULT_PRIMARY_COLOR } from "@/lib/brand/colors";
import type { PdfBrand } from "@/lib/pdf/types";
import { brandStyle, safeBrand } from "./brand-vars";

const VALID: PdfBrand = {
  primary: "#c2312b",
  secondary: "#0f1729",
  primaryText: "#c2312b",
  onPrimary: "#ffffff",
  primaryTint: "#fdeceb",
};

describe("colores de la marca en la pantalla del cliente", () => {
  it("deja pasar una marca válida tal cual", () => {
    expect(safeBrand(VALID)).toEqual(VALID);
  });

  it("un color que no es #rrggbb se cambia por el de partida: nunca llega texto libre a un estilo", () => {
    const hostile = { ...VALID, primary: "red; background:url(//malo.test)" };
    const safe = safeBrand(hostile);
    expect(safe.primary).toBe(DEFAULT_PRIMARY_COLOR);
    for (const color of Object.values(safe)) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("entrega las variables que usa la pantalla", () => {
    expect(brandStyle(VALID)).toMatchObject({
      "--brand": "#c2312b",
      "--on-brand": "#ffffff",
      "--brand-tint": "#fdeceb",
    });
  });
});
