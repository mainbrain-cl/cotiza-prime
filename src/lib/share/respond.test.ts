import { describe, expect, it } from "vitest";
import {
  MSG_CONFIRM_REQUIRED,
  MSG_NAME_REQUIRED,
  MSG_REASON_REQUIRED,
  MSG_REASON_TEXT_NOT_ALLOWED,
  MSG_REASON_TEXT_REQUIRED,
  NAME_MAX_LENGTH,
  REASON_TEXT_MAX_LENGTH,
  acceptInputSchema,
  cleanOneLine,
  fieldErrorsOf,
  rejectInputSchema,
} from "./respond";

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
