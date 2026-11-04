import { describe, expect, it } from "vitest";
import { SNIPPET_EXCERPT_LENGTH, groupSnippets, snippetExcerpt, type SnippetRow } from "./groups";

const row = (over: Partial<SnippetRow> & Pick<SnippetRow, "id" | "kind" | "name">): SnippetRow => ({
  body: "Texto.",
  isDefault: false,
  revision: 1,
  updatedAt: "2026-11-04T12:00:00.000Z",
  ...over,
});

describe("groupSnippets", () => {
  it("agrupa por tipo en el orden de la pantalla y ordena por nombre sin mirar mayúsculas ni tildes", () => {
    const groups = groupSnippets([
      row({ id: "1", kind: "footer_note", name: "Vigencia" }),
      row({ id: "2", kind: "conditions", name: "pago a 30 días" }),
      row({ id: "3", kind: "email_body", name: "Saludo" }),
      row({ id: "4", kind: "conditions", name: "Ánticipo" }),
      row({ id: "5", kind: "conditions", name: "Contado" }),
      row({ id: "6", kind: "email_body", name: "Seguimiento" }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["email_body", "conditions", "footer_note"]);
    expect(groups.map((g) => g.label)).toEqual([
      "Texto del correo",
      "Condiciones comerciales",
      "Notas al pie",
    ]);
    expect(groups[0].rows.map((r) => r.name)).toEqual(["Saludo", "Seguimiento"]);
    expect(groups[1].rows.map((r) => r.name)).toEqual(["Ánticipo", "Contado", "pago a 30 días"]);
  });

  it("sin textos no hay grupos", () => {
    expect(groupSnippets([])).toEqual([]);
  });

  it("no modifica la lista que recibe", () => {
    const input = [
      row({ id: "1", kind: "conditions", name: "B" }),
      row({ id: "2", kind: "conditions", name: "A" }),
    ];
    groupSnippets(input);
    expect(input.map((r) => r.name)).toEqual(["B", "A"]);
  });
});

describe("snippetExcerpt", () => {
  it("deja el texto corto como está, en una sola línea", () => {
    expect(snippetExcerpt("Hola\n\n  mundo ")).toBe("Hola mundo");
  });

  it("corta el texto largo con «…» sin pasar el máximo", () => {
    const long = "palabra ".repeat(100);
    const excerpt = snippetExcerpt(long);
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(SNIPPET_EXCERPT_LENGTH + 1);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("no parte un emoji por la mitad", () => {
    const excerpt = snippetExcerpt("😀".repeat(200), 10);
    expect(Array.from(excerpt)).toHaveLength(11);
    expect(excerpt.startsWith("😀".repeat(10))).toBe(true);
  });
});
