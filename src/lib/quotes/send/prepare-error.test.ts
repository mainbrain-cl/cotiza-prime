import { describe, expect, it } from "vitest";
import { LINE_RULES_GENERIC_MESSAGE } from "@/lib/quotes/line-rules-block";
import {
  MSG_CHANGED,
  MSG_FORBIDDEN_SEND,
  MSG_IN_PROGRESS_OTHER,
  MSG_NOT_DRAFT,
  MSG_NOT_FOUND,
  MSG_NO_LINES,
  MSG_UNEXPECTED,
  isExpectedPrepareError,
  prepareErrorMessage,
} from "./prepare-error";

describe("los errores al preparar el envío", () => {
  it("las reglas de precio (CP422) dicen qué línea corregir, antes que el mensaje general", () => {
    expect(
      prepareErrorMessage({ code: "CP422", message: "line_rules_invalid: price_locked@1" }),
    ).toBe(
      "La línea 2 tiene un precio bloqueado distinto al del catálogo. Vuelve a la cotización y usa el precio del catálogo.",
    );
    expect(prepareErrorMessage({ code: "CP422", message: "line_rules_invalid: nuevo@3" })).toBe(
      LINE_RULES_GENERIC_MESSAGE,
    );
  });

  it("los demás errores de datos y de permiso siguen como antes", () => {
    expect(prepareErrorMessage({ code: "42501" })).toBe(MSG_FORBIDDEN_SEND);
    expect(prepareErrorMessage({ code: "CP404" })).toBe(MSG_NOT_FOUND);
    expect(prepareErrorMessage({ code: "CP409", message: "send_in_progress" })).toBe(
      MSG_IN_PROGRESS_OTHER,
    );
    expect(prepareErrorMessage({ code: "CP409", message: "revision" })).toBe(MSG_CHANGED);
    expect(prepareErrorMessage({ code: "CP422", message: "no_lines" })).toBe(MSG_NO_LINES);
    expect(prepareErrorMessage({ code: "CP422", message: "otra cosa" })).toBe(MSG_UNEXPECTED);
    expect(prepareErrorMessage({ code: "CP423", message: "not_draft" })).toBe(MSG_NOT_DRAFT);
    expect(prepareErrorMessage({ code: "XX000" })).toBe(MSG_UNEXPECTED);
  });

  it("la regla de aprobación sigue distinguiéndose dentro del mismo CP423", () => {
    expect(prepareErrorMessage({ code: "CP423", message: "approval_required" })).toMatch(
      /necesita aprobación/,
    );
  });

  it("las reglas de precio son un rechazo esperado: no se registran como advertencia del servidor", () => {
    expect(
      isExpectedPrepareError({ code: "CP422", message: "line_rules_invalid: price_locked@0" }),
    ).toBe(true);
    expect(isExpectedPrepareError({ code: "CP409" })).toBe(true);
    expect(isExpectedPrepareError({ code: "42501" })).toBe(true);
    expect(isExpectedPrepareError({ code: "CP423", message: "approval_required" })).toBe(true);
    expect(isExpectedPrepareError({ code: "CP423", message: "not_draft" })).toBe(false);
    expect(isExpectedPrepareError({ code: "CP422", message: "no_lines" })).toBe(false);
    expect(isExpectedPrepareError({ code: "XX000" })).toBe(false);
  });
});
