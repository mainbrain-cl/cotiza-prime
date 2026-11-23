import { describe, expect, it } from "vitest";
import { groupSnippets, type SnippetRow } from "./groups";
import { NO_SNIPPETS, quoteFieldSnippets } from "./quote-fields";

const row = (kind: SnippetRow["kind"], name: string, body = `${name} texto`): SnippetRow => ({
  id: `id-${kind}-${name}`,
  kind,
  name,
  body,
  isDefault: false,
  revision: 1,
  updatedAt: "2026-11-01T00:00:00Z",
});

describe("quoteFieldSnippets (qué textos ofrece cada campo, H-048b)", () => {
  it("cada campo recibe solo los textos de su tipo, ordenados por nombre; el correo no se ofrece", () => {
    const result = quoteFieldSnippets(
      groupSnippets([
        row("conditions", "Zeta"),
        row("conditions", "Alfa"),
        row("exclusions", "Sin embalaje"),
        row("footer_note", "Pie estándar"),
        row("email_body", "Saludo"),
      ]),
    );
    expect(result.available).toBe(true);
    expect(result.byKind.conditions.map((s) => s.name)).toEqual(["Alfa", "Zeta"]);
    expect(result.byKind.exclusions.map((s) => s.name)).toEqual(["Sin embalaje"]);
    expect(result.byKind.footer_note.map((s) => s.name)).toEqual(["Pie estándar"]);
    expect(JSON.stringify(result)).not.toContain("Saludo");
  });

  it("solo lleva el identificador, el nombre y el texto (no la revisión ni las fechas)", () => {
    const result = quoteFieldSnippets(groupSnippets([row("exclusions", "A")]));
    expect(Object.keys(result.byKind.exclusions[0]).sort()).toEqual(["body", "id", "name"]);
  });

  it("sin textos guardados todos los campos quedan vacíos, y si la lectura falló lo dice", () => {
    expect(quoteFieldSnippets([])).toEqual(NO_SNIPPETS);
    const failed = quoteFieldSnippets(null);
    expect(failed.available).toBe(false);
    expect(failed.byKind.conditions).toEqual([]);
  });
});
