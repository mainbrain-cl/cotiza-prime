import { describe, expect, it } from "vitest";
import { normalizeEmail } from "./email";

describe("normalizeEmail", () => {
  it("recorta y pasa a minúsculas", () => {
    expect(normalizeEmail("  Ana@Ejemplo.TEST ")).toBe("ana@ejemplo.test");
  });

  it("no toca puntos ni +etiqueta", () => {
    expect(normalizeEmail("a.na+ventas@ejemplo.test")).toBe("a.na+ventas@ejemplo.test");
  });

  it("normaliza Unicode a NFC", () => {
    const decomposed = "josé@ejemplo.test"; // e + acento combinado
    expect(normalizeEmail(decomposed)).toBe("josé@ejemplo.test");
  });
});
