import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SNIPPET_BODY_MAX_LENGTH, SNIPPET_NAME_MAX_LENGTH } from "./model";
import {
  SNIPPET_DEFAULT_ONLY_EMAIL_MESSAGE,
  checkKindRules,
  createSnippetSchema,
  deleteSnippetSchema,
  snippetBodySchema,
  snippetNameSchema,
  updateSnippetSchema,
} from "./schemas";

const valid = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  kind: "email_body",
  name: "Saludo corto",
  body: "Estimado {{cliente}}:\n\nAdjunto la cotización {{numero}}.",
  isDefault: false,
  ...over,
});

const messageOf = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((i) => i.message) ?? [];

describe("nombre", () => {
  it("se recorta y acepta de 1 a 80 caracteres", () => {
    expect(snippetNameSchema.parse("  Condiciones 30 días \n")).toBe("Condiciones 30 días");
    expect(snippetNameSchema.parse("a".repeat(SNIPPET_NAME_MAX_LENGTH))).toHaveLength(80);
  });

  it("rechaza vacío, solo espacios, 81 caracteres, saltos de línea y caracteres invisibles", () => {
    for (const bad of [
      "",
      "   ",
      "a".repeat(81),
      "dos\nlíneas",
      "con\ttab",
      "ocu\u200blto",
      "rtl\u202e",
    ]) {
      expect(snippetNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(snippetNameSchema.safeParse(42).success).toBe(false);
    expect(snippetNameSchema.safeParse(null).success).toBe(false);
  });

  it("80 emojis caben; 81 no (se cuenta por carácter)", () => {
    expect(snippetNameSchema.safeParse("😀".repeat(80)).success).toBe(true);
    expect(snippetNameSchema.safeParse("😀".repeat(81)).success).toBe(false);
  });
});

describe("texto", () => {
  it("de 1 a 4.000 caracteres; los saltos de Windows pasan a uno solo", () => {
    expect(snippetBodySchema.parse("Hola\r\nChao\r\n")).toBe("Hola\nChao");
    expect(snippetBodySchema.safeParse("a".repeat(SNIPPET_BODY_MAX_LENGTH)).success).toBe(true);
    expect(snippetBodySchema.safeParse("a".repeat(SNIPPET_BODY_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });

  it("rechaza vacío, solo espacios y caracteres de control o invisibles", () => {
    for (const bad of ["", " \n\t ", "a\u0001b", "a\u200bb", "a\u202eb", "a\ufeffb"]) {
      expect(snippetBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("acepta tabulador y salto de línea", () => {
    expect(snippetBodySchema.safeParse("a\tb\nc").success).toBe(true);
  });
});

describe("crear", () => {
  it("un texto del correo válido, con variables", () => {
    const parsed = createSnippetSchema.parse(valid());
    expect(parsed.kind).toBe("email_body");
    expect(parsed.body).toContain("{{cliente}}");
  });

  it("los cuatro tipos sin variables son válidos", () => {
    for (const kind of ["email_body", "conditions", "exclusions", "footer_note"]) {
      expect(createSnippetSchema.safeParse(valid({ kind, body: "Texto simple." })).success).toBe(
        true,
      );
    }
  });

  it("un tipo desconocido se rechaza", () => {
    expect(createSnippetSchema.safeParse(valid({ kind: "asunto" })).success).toBe(false);
  });

  it("variables fuera del correo: se rechazan con un mensaje claro", () => {
    for (const kind of ["conditions", "exclusions", "footer_note"]) {
      const result = createSnippetSchema.safeParse(valid({ kind, body: "Para {{cliente}}" }));
      expect(result.success).toBe(false);
      expect(messageOf(result).join(" ")).toContain("solo se pueden usar en el texto del correo");
    }
  });

  it("variable desconocida o demasiadas variables en el correo", () => {
    expect(createSnippetSchema.safeParse(valid({ body: "Hola {{nombre}}" })).success).toBe(false);
    expect(createSnippetSchema.safeParse(valid({ body: "{{cliente}}".repeat(10) })).success).toBe(
      true,
    );
    const many = createSnippetSchema.safeParse(valid({ body: "{{cliente}}".repeat(11) }));
    expect(many.success).toBe(false);
    expect(messageOf(many).join(" ")).toContain("demasiadas variables");
  });

  it("«texto inicial» solo en el correo", () => {
    expect(createSnippetSchema.safeParse(valid({ isDefault: true })).success).toBe(true);
    const result = createSnippetSchema.safeParse(
      valid({ kind: "conditions", body: "Pago a 30 días.", isDefault: true }),
    );
    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain(SNIPPET_DEFAULT_ONLY_EMAIL_MESSAGE);
  });

  it("rechaza claves de más, identificadores malos y falta de campos", () => {
    expect(createSnippetSchema.safeParse({ ...valid(), tenantId: randomUUID() }).success).toBe(
      false,
    );
    expect(createSnippetSchema.safeParse(valid({ id: "no-es-uuid" })).success).toBe(false);
    expect(createSnippetSchema.safeParse(valid({ isDefault: undefined })).success).toBe(false);
    expect(createSnippetSchema.safeParse(valid({ name: undefined })).success).toBe(false);
  });
});

describe("cambiar y eliminar", () => {
  const update = (over: Record<string, unknown> = {}) => {
    const { id, name, body, isDefault } = valid();
    return { id, expectedRevision: 1, name, body, isDefault, ...over };
  };

  it("cambiar pide la revisión que se vio", () => {
    expect(updateSnippetSchema.safeParse(update()).success).toBe(true);
    for (const expectedRevision of [0, -1, 1.5, "1", undefined, 2_147_483_648]) {
      expect(updateSnippetSchema.safeParse(update({ expectedRevision })).success).toBe(false);
    }
  });

  it("cambiar no recibe el tipo (nunca cambia): mandarlo se rechaza", () => {
    expect(updateSnippetSchema.safeParse(update()).success).toBe(true);
    expect(updateSnippetSchema.safeParse(update({ kind: "exclusions" })).success).toBe(false);
  });

  it("las reglas de variables y de texto inicial se revisan aparte con el tipo guardado", () => {
    expect(checkKindRules("exclusions", { body: "{{cliente}}", isDefault: false })?.path).toBe(
      "body",
    );
    expect(checkKindRules("footer_note", { body: "x", isDefault: true })).toEqual({
      path: "isDefault",
      message: SNIPPET_DEFAULT_ONLY_EMAIL_MESSAGE,
    });
    expect(checkKindRules("email_body", { body: "Hola {{cliente}}", isDefault: true })).toBeNull();
    expect(checkKindRules("conditions", { body: "Pago a 30 días.", isDefault: false })).toBeNull();
  });

  it("eliminar pide solo el identificador", () => {
    expect(deleteSnippetSchema.safeParse({ id: randomUUID() }).success).toBe(true);
    expect(deleteSnippetSchema.safeParse({ id: randomUUID(), extra: 1 }).success).toBe(false);
    expect(deleteSnippetSchema.safeParse({ id: "x" }).success).toBe(false);
  });
});
