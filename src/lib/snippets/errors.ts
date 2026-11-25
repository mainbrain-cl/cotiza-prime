import { NO_PERMISSION_MESSAGE } from "@/lib/permissions/matrix";
import {
  SNIPPET_BODY_MAX_LENGTH,
  SNIPPET_NAME_MAX_LENGTH,
  SNIPPETS_MAX_PER_TENANT,
  SNIPPET_VARIABLE_PROBLEM_MESSAGES,
  type SnippetVariableProblem,
} from "./model";
import { SNIPPET_DEFAULT_ONLY_EMAIL_MESSAGE } from "./schemas";

/**
 * Traduce los errores de las funciones de textos guardados (H-048a) a mensajes claros, sin detalle técnico.
 * Los códigos son los de la base: 42501 sin permiso, CP404 no existe en esta organización, CP409 otra persona
 * guardó antes y CP422 dato inválido (el motivo viaja en el mensaje del error).
 */

export type SnippetErrorKind =
  "forbidden" | "not_found" | "conflict" | "invalid" | "limit" | "other";
/** Campo del formulario al que pertenece el problema, si es de uno solo. */
export type SnippetField = "name" | "body" | "isDefault";
export type SnippetError = { kind: SnippetErrorKind; message: string; field?: SnippetField };

export const SNIPPET_GENERIC_FAILURE =
  "No pudimos completar la acción. Intenta de nuevo en unos minutos; si sigue igual, avísanos.";
export const SNIPPET_NOT_FOUND =
  "No encontramos este texto. Puede que otra persona lo haya eliminado.";
export const SNIPPET_CONFLICT =
  "Otra persona cambió este texto mientras lo editabas. Recarga para ver la versión actual.";
export const SNIPPET_NAME_TAKEN =
  "Ya tienes un texto con ese nombre en este tipo. Elige otro nombre.";
export const SNIPPET_TOO_MANY = `Llegaste al máximo de ${SNIPPETS_MAX_PER_TENANT} textos guardados. Elimina alguno para crear otro.`;
export const SNIPPET_INVALID_NAME = `Revisa el nombre: debe tener entre 1 y ${SNIPPET_NAME_MAX_LENGTH} caracteres, en una sola línea y sin caracteres no permitidos.`;
export const SNIPPET_INVALID_BODY = `Revisa el texto: debe tener entre 1 y ${SNIPPET_BODY_MAX_LENGTH.toLocaleString("es-CL")} caracteres y sin caracteres no permitidos.`;

const VARIABLE_PROBLEMS: readonly string[] = [
  "variables_not_allowed",
  "unknown_variable",
  "too_many_variables",
  "variable_in_link",
] satisfies SnippetVariableProblem[];

export function mapSnippetError(error: {
  code?: string | null;
  message?: string | null;
}): SnippetError {
  const code = error.code ?? "";
  const reason = (error.message ?? "").trim();
  if (code === "42501") return { kind: "forbidden", message: NO_PERMISSION_MESSAGE };
  if (code === "CP404") return { kind: "not_found", message: SNIPPET_NOT_FOUND };
  if (code === "CP409") return { kind: "conflict", message: SNIPPET_CONFLICT };
  if (code === "CP422") {
    if (reason === "name_taken") {
      return { kind: "invalid", message: SNIPPET_NAME_TAKEN, field: "name" };
    }
    if (reason === "invalid_name") {
      return { kind: "invalid", message: SNIPPET_INVALID_NAME, field: "name" };
    }
    if (reason === "invalid_body") {
      return { kind: "invalid", message: SNIPPET_INVALID_BODY, field: "body" };
    }
    if (reason === "default_only_email") {
      return { kind: "invalid", message: SNIPPET_DEFAULT_ONLY_EMAIL_MESSAGE, field: "isDefault" };
    }
    if (VARIABLE_PROBLEMS.includes(reason)) {
      return {
        kind: "invalid",
        message: SNIPPET_VARIABLE_PROBLEM_MESSAGES[reason as SnippetVariableProblem],
        field: "body",
      };
    }
    if (reason === "too_many_snippets") return { kind: "limit", message: SNIPPET_TOO_MANY };
  }
  return { kind: "other", message: SNIPPET_GENERIC_FAILURE };
}
