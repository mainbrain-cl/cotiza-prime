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
    // con espacios o saltos de línea de más alrededor del texto guardado, es el mismo texto
    expect(
      appendSnippet("Antes.\n\nNo incluye embalaje.\n\nDespués.", " No incluye embalaje.\n"),
    ).toEqual({ status: "already_added" });
    expect(isSnippetInField("abc", "")).toBe(false);
    expect(isSnippetInField("abc", "   ")).toBe(false);
  });

  it("«Ya agregado» compara por bloques completos, no por pedazos de texto (revisión de Aarón al PR #67)", () => {
    // un texto corto que es PARTE de otro más largo no cuenta como ya agregado
    expect(isSnippetInField("No incluye IVA ni transporte.", "No incluye IVA")).toBe(false);
    expect(appendSnippet("No incluye IVA ni transporte.", "No incluye IVA")).toEqual({
      status: "ok",
      text: "No incluye IVA ni transporte.\n\nNo incluye IVA",
    });
    // pero sí cuenta si está como un bloque propio, solo o junto a otros, con cualquier cantidad de líneas en blanco
    expect(isSnippetInField("No incluye IVA", "No incluye IVA")).toBe(true);
    expect(isSnippetInField("Antes.\n\nNo incluye IVA\n\nDespués.", "No incluye IVA")).toBe(true);
    expect(isSnippetInField("Antes.\n\n\n  No incluye IVA  \n\n\nDespués.", "No incluye IVA")).toBe(
      true,
    );
    // un texto de varios párrafos se compara párrafo a párrafo, en orden y juntos
    expect(isSnippetInField("A.\n\nB.\n\nC.", "B.\n\nC.")).toBe(true);
    expect(isSnippetInField("A.\n\nX.\n\nC.", "A.\n\nC.")).toBe(false);
    expect(isSnippetInField("B.\n\nA.", "A.\n\nB.")).toBe(false);
    // el mismo texto en una sola línea con otro texto pegado, no
    expect(isSnippetInField("Antes. No incluye IVA. Después.", "No incluye IVA.")).toBe(false);
  });

  it("«Ya agregado» detecta una exclusión escrita como una línea dentro de un párrafo, y con saltos de línea de Windows", () => {
    // las exclusiones se escriben una debajo de otra, sin línea en blanco
    const field = "No incluye embalaje.\nNo incluye seguro.\nNo incluye peajes.";
    expect(isSnippetInField(field, "No incluye seguro.")).toBe(true);
    expect(appendSnippet(field, "No incluye seguro.")).toEqual({ status: "already_added" });
    expect(isSnippetInField(field, "No incluye seguro")).toBe(false);
    expect(isSnippetInField(field, "No incluye")).toBe(false);
    // un texto de dos líneas tiene que estar completo y seguido
    expect(isSnippetInField(field, "No incluye seguro.\nNo incluye peajes.")).toBe(true);
    expect(isSnippetInField(field, "No incluye embalaje.\nNo incluye peajes.")).toBe(false);
    // los saltos de Windows cuentan como uno
    expect(isSnippetInField("Uno.\r\nDos.\r\n\r\nTres.", "Dos.")).toBe(true);
    expect(isSnippetInField("Uno.\nDos.", "Uno.\r\nDos.")).toBe(true);
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
