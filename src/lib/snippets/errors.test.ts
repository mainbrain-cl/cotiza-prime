import { describe, expect, it } from "vitest";
import { NO_PERMISSION_MESSAGE } from "@/lib/permissions/matrix";
import {
  SNIPPET_CONFLICT,
  SNIPPET_GENERIC_FAILURE,
  SNIPPET_INVALID_BODY,
  SNIPPET_INVALID_NAME,
  SNIPPET_NAME_TAKEN,
  SNIPPET_NOT_FOUND,
  SNIPPET_TOO_MANY,
  mapSnippetError,
} from "./errors";
import { SNIPPET_VARIABLE_PROBLEM_MESSAGES } from "./model";
import { SNIPPET_DEFAULT_ONLY_EMAIL_MESSAGE } from "./schemas";

// Cada código de error de las tres funciones de la base se traduce a un mensaje claro en español de Chile.

const CASES: [string, string, ReturnType<typeof mapSnippetError>][] = [
  ["42501", "forbidden", { kind: "forbidden", message: NO_PERMISSION_MESSAGE }],
  ["CP404", "not_found", { kind: "not_found", message: SNIPPET_NOT_FOUND }],
  ["CP404", "snippet_not_found", { kind: "not_found", message: SNIPPET_NOT_FOUND }],
  ["CP409", "revision_conflict", { kind: "conflict", message: SNIPPET_CONFLICT }],
  ["CP422", "name_taken", { kind: "invalid", message: SNIPPET_NAME_TAKEN, field: "name" }],
  ["CP422", "invalid_name", { kind: "invalid", message: SNIPPET_INVALID_NAME, field: "name" }],
  ["CP422", "invalid_body", { kind: "invalid", message: SNIPPET_INVALID_BODY, field: "body" }],
  [
    "CP422",
    "default_only_email",
    { kind: "invalid", message: SNIPPET_DEFAULT_ONLY_EMAIL_MESSAGE, field: "isDefault" },
  ],
  [
    "CP422",
    "unknown_variable",
    { kind: "invalid", message: SNIPPET_VARIABLE_PROBLEM_MESSAGES.unknown_variable, field: "body" },
  ],
  [
    "CP422",
    "variables_not_allowed",
    {
      kind: "invalid",
      message: SNIPPET_VARIABLE_PROBLEM_MESSAGES.variables_not_allowed,
      field: "body",
    },
  ],
  [
    "CP422",
    "too_many_variables",
    {
      kind: "invalid",
      message: SNIPPET_VARIABLE_PROBLEM_MESSAGES.too_many_variables,
      field: "body",
    },
  ],
  ["CP422", "too_many_snippets", { kind: "limit", message: SNIPPET_TOO_MANY }],
  ["CP422", "invalid_kind", { kind: "other", message: SNIPPET_GENERIC_FAILURE }],
  ["CP422", "invalid_arguments", { kind: "other", message: SNIPPET_GENERIC_FAILURE }],
  ["CP422", "id_in_use", { kind: "other", message: SNIPPET_GENERIC_FAILURE }],
  ["XX000", "boom", { kind: "other", message: SNIPPET_GENERIC_FAILURE }],
];

describe("mapSnippetError", () => {
  it.each(CASES)("%s «%s»", (code, message, expected) => {
    expect(mapSnippetError({ code, message })).toEqual(expected);
  });

  it("sin código ni mensaje, el mensaje genérico", () => {
    expect(mapSnippetError({})).toEqual({ kind: "other", message: SNIPPET_GENERIC_FAILURE });
    expect(mapSnippetError({ code: null, message: null }).kind).toBe("other");
  });

  it("el conflicto de revisión pide recargar y los mensajes no llevan jerga técnica", () => {
    expect(SNIPPET_CONFLICT).toBe(
      "Otra persona cambió este texto mientras lo editabas. Recarga para ver la versión actual.",
    );
    for (const [, , result] of CASES) {
      expect(result.message).not.toMatch(/CP4|42501|revision_conflict|_/);
    }
  });
});
