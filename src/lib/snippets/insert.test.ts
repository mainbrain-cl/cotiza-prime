import { describe, expect, it } from "vitest";
import { appendSnippet, fieldLength, isSnippetInField, tooLongMessage } from "./insert";

describe("appendSnippet (insertar un texto guardado, H-048b)", () => {
  it("en un campo vacío deja solo el texto, sin espacios sobrantes", () => {
    expect(appendSnippet("", "  No incluye embalaje.  ")).toEqual({
      status: "ok",
      text: "No incluye embalaje.",
    });
    expect(appendSnippet("   \n", "Texto")).toEqual({ status: "ok", text: "Texto" });
  });

  it("con texto escrito, agrega al final separado por una línea en blanco", () => {
    expect(appendSnippet("Lo que ya escribí.", "Texto guardado")).toEqual({
      status: "ok",
      text: "Lo que ya escribí.\n\nTexto guardado",
    });
    // los espacios y saltos del final del campo no se acumulan
    expect(appendSnippet("Lo que ya escribí.\n\n\n  ", "Texto guardado")).toEqual({
      status: "ok",
      text: "Lo que ya escribí.\n\nTexto guardado",
    });
  });

  it("si el texto ya está en el campo, no se agrega otra vez", () => {
    const once = appendSnippet("", "No incluye embalaje.");
    if (once.status !== "ok") throw new Error("debía agregarse");
    expect(appendSnippet(once.text, "No incluye embalaje.")).toEqual({ status: "already_added" });
    expect(
      appendSnippet("Antes. No incluye embalaje. Después.", " No incluye embalaje.\n"),
    ).toEqual({ status: "already_added" });
    expect(isSnippetInField("abc", "")).toBe(false);
    expect(isSnippetInField("abc", "   ")).toBe(false);
  });

  it("si pasaría del máximo, no se agrega y dice cuánto quedaría", () => {
    const field = "x".repeat(3_000);
    const body = "y".repeat(1_312);
    expect(appendSnippet(field, body)).toEqual({
      status: "too_long",
      resultingLength: 3_000 + 2 + 1_312,
      max: 4_000,
    });
  });

  it("justo en el máximo sí cabe; uno más, no", () => {
    expect(appendSnippet("", "x".repeat(4_000)).status).toBe("ok");
    expect(appendSnippet("", "x".repeat(4_001)).status).toBe("too_long");
    // 3.998 + el separador de 2 caracteres + 0 de texto nuevo no aplica; con 1 carácter nuevo: 3.997 + 2 + 1 = 4.000
    expect(appendSnippet("x".repeat(3_997), "y").status).toBe("ok");
    expect(appendSnippet("x".repeat(3_998), "y").status).toBe("too_long");
  });

  it("el largo de un campo no cuenta los espacios de los bordes", () => {
    expect(fieldLength("  hola \n")).toBe(4);
  });

  it("el aviso usa los números a la chilena", () => {
    expect(tooLongMessage(4_312, 4_000)).toBe(
      "No cabe: quedaría con 4.312 caracteres (máximo 4.000)",
    );
  });
});
