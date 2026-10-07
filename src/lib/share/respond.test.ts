import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MSG_CONFIRM_REQUIRED,
  MSG_NAME_LETTERS,
  MSG_NAME_REQUIRED,
  MSG_REASON_REQUIRED,
  MSG_REASON_TEXT_NOT_ALLOWED,
  MSG_REASON_TEXT_REQUIRED,
  ACCEPTANCE_TEXT,
  ACCEPTANCE_TEXT_VERSION,
  NAME_MAX_LENGTH,
  REJECT_REASONS,
  REASON_TEXT_MAX_LENGTH,
  acceptInputSchema,
  cleanOneLine,
  fieldErrorsOf,
  reasonLabel,
  reasonTeamText,
  newResponseKey,
  rejectInputSchema,
  visibleErrors,
} from "./respond";

const V1_FINGERPRINT = "6481ad8480d07468c2db9ff511f7d692f2f88d3ea86ccd7c54e1a6efc40abf64";
const KEY = "0b0f6a6e-3c3e-4a4f-9b8c-1d2e3f4a5b6c";

function acceptErrors(input: object) {
  const parsed = acceptInputSchema.safeParse({ responseKey: KEY, ...input });
  return parsed.success ? null : fieldErrorsOf(parsed.error);
}

function rejectErrors(input: object) {
  const parsed = rejectInputSchema.safeParse({ responseKey: KEY, ...input });
  return parsed.success ? null : fieldErrorsOf(parsed.error);
}

describe("aceptar (H-031)", () => {
  it("con nombre y conformidad es válido, y el nombre queda limpio", () => {
    const parsed = acceptInputSchema.parse({
      responseKey: KEY,
      name: "  María   José\n Pérez ",
      confirmed: true,
    });
    expect(parsed.name).toBe("María José Pérez");
  });

  it("nombre vacío, de solo espacios o de un carácter: pide el nombre", () => {
    for (const name of ["", "   ", "\n\t", "A"]) {
      expect(acceptErrors({ name, confirmed: true })?.name, JSON.stringify(name)).toBe(
        MSG_NAME_REQUIRED,
      );
    }
    expect(acceptErrors({ confirmed: true })?.name).toBe(MSG_NAME_REQUIRED);
  });

  it("nombre demasiado largo", () => {
    expect(acceptErrors({ name: "a".repeat(NAME_MAX_LENGTH + 1), confirmed: true })?.name).toMatch(
      /hasta 120/,
    );
    expect(acceptErrors({ name: "a".repeat(NAME_MAX_LENGTH), confirmed: true })).toBeNull();
  });

  it("sin la casilla de conformidad no se acepta", () => {
    expect(acceptErrors({ name: "Ana Prueba", confirmed: false })?.confirmed).toBe(
      MSG_CONFIRM_REQUIRED,
    );
    expect(acceptErrors({ name: "Ana Prueba" })?.confirmed).toBe(MSG_CONFIRM_REQUIRED);
    expect(acceptErrors({ name: "Ana Prueba", confirmed: "true" })?.confirmed).toBe(
      MSG_CONFIRM_REQUIRED,
    );
  });

  it("la clave del envío tiene que ser un identificador válido", () => {
    const parsed = acceptInputSchema.safeParse({
      responseKey: "no-es-uuid",
      name: "Ana",
      confirmed: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("rechazar (H-031)", () => {
  it("sin motivo no se registra", () => {
    expect(rejectErrors({})?.reasonCode).toBe(MSG_REASON_REQUIRED);
    expect(rejectErrors({ reasonCode: "" })?.reasonCode).toBe(MSG_REASON_REQUIRED);
    expect(rejectErrors({ reasonCode: "mala_onda" })?.reasonCode).toBe(MSG_REASON_REQUIRED);
  });

  it("cada motivo de la lista es válido sin texto", () => {
    for (const reasonCode of [
      "price_too_high",
      "not_in_budget",
      "chose_other_provider",
      "timing",
      "no_longer_needed",
    ]) {
      expect(rejectErrors({ reasonCode }), reasonCode).toBeNull();
    }
  });

  it("«otro» sin texto, o con 2 caracteres, pide el detalle", () => {
    expect(rejectErrors({ reasonCode: "other" })?.reasonText).toBe(MSG_REASON_TEXT_REQUIRED);
    expect(rejectErrors({ reasonCode: "other", reasonText: "   " })?.reasonText).toBe(
      MSG_REASON_TEXT_REQUIRED,
    );
    expect(rejectErrors({ reasonCode: "other", reasonText: "ab" })?.reasonText).toBe(
      MSG_REASON_TEXT_REQUIRED,
    );
  });

  it("«otro» acepta de 3 a 200 caracteres y rechaza 201", () => {
    expect(rejectErrors({ reasonCode: "other", reasonText: "abc" })).toBeNull();
    expect(
      rejectErrors({ reasonCode: "other", reasonText: "x".repeat(REASON_TEXT_MAX_LENGTH) }),
    ).toBeNull();
    expect(
      rejectErrors({ reasonCode: "other", reasonText: "x".repeat(REASON_TEXT_MAX_LENGTH + 1) })
        ?.reasonText,
    ).toBe(MSG_REASON_TEXT_REQUIRED);
  });

  it("el texto solo se admite con «otro»", () => {
    expect(rejectErrors({ reasonCode: "timing", reasonText: "algo" })?.reasonText).toBe(
      MSG_REASON_TEXT_NOT_ALLOWED,
    );
    // vacío o de solo espacios con un motivo de la lista: no cuenta como texto
    expect(rejectErrors({ reasonCode: "timing", reasonText: "  " })).toBeNull();
  });
});

describe("limpieza de textos del cliente", () => {
  it("quita saltos de línea, controles, ancho cero y marcas de dirección", () => {
    expect(cleanOneLine("a\r\nb\u0000c​d‮e")).toBe("a b c d e");
    expect(cleanOneLine("  uno   dos ")).toBe("uno dos");
  });
});

describe("nombre de quien acepta: caracteres invisibles y normalización", () => {
  it("normaliza a NFC y quita guion blando, relleno hangul y caracteres de etiqueta", () => {
    expect(cleanOneLine("José")).toBe("José");
    expect(cleanOneLine("Ana­Maria")).toBe("AnaMaria");
    expect(cleanOneLine("AnaㅤMaria")).toBe("AnaMaria");
    expect(cleanOneLine("Ana\u{E0041}\u{E007F}")).toBe("Ana");
  });

  it("un nombre hecho solo de relleno invisible o de símbolos se rechaza", () => {
    expect(acceptErrors({ name: "ㅤㅤㅤ", confirmed: true })?.name).toBe(MSG_NAME_REQUIRED);
    expect(acceptErrors({ name: "1234 -- 99", confirmed: true })?.name).toBe(MSG_NAME_LETTERS);
  });

  it("un nombre con <script> se acepta como texto, sin cambiar (se escapa al mostrarlo)", () => {
    const parsed = acceptInputSchema.parse({
      responseKey: KEY,
      name: "<script>alert(1)</script> Ana",
      confirmed: true,
    });
    expect(parsed.name).toBe("<script>alert(1)</script> Ana");
  });
});

describe("texto de conformidad y lista de motivos", () => {
  it("el texto de conformidad v1 está amarrado a su huella: si cambia, hay que subir la versión", () => {
    // Si esta prueba falla, el texto cambió: crea una versión nueva (v2), no edites la v1, porque cada
    // aceptación guardada dice qué versión del texto aceptó el cliente.
    const fingerprint = createHash("sha256").update(ACCEPTANCE_TEXT, "utf8").digest("hex");
    expect(ACCEPTANCE_TEXT_VERSION).toBe("v1");
    expect(fingerprint).toBe(V1_FINGERPRINT);
  });

  it("una sola lista de motivos: todos tienen texto para el cliente y para el equipo", () => {
    for (const reason of REJECT_REASONS) {
      expect(reasonLabel(reason.code)).toBe(reason.label);
      expect(reasonTeamText(reason.code)).toBe(reason.teamText);
    }
    expect(reasonTeamText("inventado")).toBeUndefined();
  });
});

describe("errores visibles y clave del formulario", () => {
  it("un error que no es de un campo del formulario pasa a ser el error del formulario", () => {
    expect(
      visibleErrors({ responseKey: "Clave mala", name: "Falta el nombre" }, ["name", "form"]),
    ).toEqual({ form: "Clave mala", name: "Falta el nombre" });
    expect(visibleErrors({ form: "Uno", responseKey: "Dos" }, ["form"])).toEqual({ form: "Uno" });
  });

  it("la clave nueva es un UUID v4 válido, con o sin crypto.randomUUID", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(newResponseKey()).toMatch(uuid);
    const withoutRandomUuid = {
      getRandomValues: <T extends ArrayBufferView>(array: T) =>
        globalThis.crypto.getRandomValues(array),
    };
    const key = newResponseKey(withoutRandomUuid as Crypto);
    expect(key).toMatch(uuid);
    expect(
      acceptInputSchema.safeParse({ responseKey: key, name: "Ana", confirmed: true }).success,
    ).toBe(true);
  });
});
