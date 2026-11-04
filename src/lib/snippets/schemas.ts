import { z } from "zod";
import {
  SNIPPET_BODY_MAX_LENGTH,
  SNIPPET_KINDS,
  SNIPPET_KIND_WITH_VARIABLES,
  SNIPPET_NAME_MAX_LENGTH,
  SNIPPET_REVISION_MAX,
  type SnippetKind,
  checkSnippetVariables,
  hasUnsafeSnippetCharacters,
  normalizeSnippetBody,
  normalizeSnippetName,
  snippetLength,
} from "./model";

/**
 * Lo que llega de los formularios de textos guardados (H-048a). La base de datos vuelve a exigir lo mismo:
 * esto solo sirve para avisar rápido y con palabras claras.
 */

export const SNIPPET_NAME_REQUIRED_MESSAGE = "Escribe un nombre para el texto.";
export const SNIPPET_BODY_REQUIRED_MESSAGE = "Escribe el texto.";
export const SNIPPET_DEFAULT_ONLY_EMAIL_MESSAGE =
  "Solo un texto del correo puede ser el texto inicial.";
const UNSAFE_CHARACTERS_MESSAGE = "El texto tiene caracteres no permitidos.";

/** Nombre: 1 a 80 caracteres, una sola línea, sin caracteres de control ni invisibles. */
export const snippetNameSchema = z
  .string({ error: SNIPPET_NAME_REQUIRED_MESSAGE })
  .transform(normalizeSnippetName)
  .pipe(
    z
      .string()
      .refine((name) => name !== "", SNIPPET_NAME_REQUIRED_MESSAGE)
      .refine(
        (name) => snippetLength(name) <= SNIPPET_NAME_MAX_LENGTH,
        `El nombre es demasiado largo (máximo ${SNIPPET_NAME_MAX_LENGTH} caracteres).`,
      )
      .refine((name) => !hasUnsafeSnippetCharacters(name, false), UNSAFE_CHARACTERS_MESSAGE),
  );

/** Texto: 1 a 4.000 caracteres, sin caracteres de control ni invisibles. Las variables se revisan con el tipo. */
export const snippetBodySchema = z
  .string({ error: SNIPPET_BODY_REQUIRED_MESSAGE })
  .transform(normalizeSnippetBody)
  .pipe(
    z
      .string()
      .refine((body) => body !== "", SNIPPET_BODY_REQUIRED_MESSAGE)
      .refine(
        (body) => snippetLength(body) <= SNIPPET_BODY_MAX_LENGTH,
        `El texto es demasiado largo (máximo ${SNIPPET_BODY_MAX_LENGTH.toLocaleString("es-CL")} caracteres).`,
      )
      .refine((body) => !hasUnsafeSnippetCharacters(body, true), UNSAFE_CHARACTERS_MESSAGE),
  );

const snippetKindSchema = z.enum(SNIPPET_KINDS, { error: "Elige el tipo de texto." });

/**
 * Variables y «texto inicial»: dependen del tipo. Devuelve el primer problema (con el campo al que pertenece) o
 * `null`. Para cambiar un texto, el tipo es el que ya tiene guardado (el servidor lo lee de la fila), nunca el
 * que mande el navegador.
 */
export function checkKindRules(
  kind: SnippetKind,
  value: { body: string; isDefault: boolean },
): { path: "body" | "isDefault"; message: string } | null {
  const check = checkSnippetVariables(kind, value.body);
  if (!check.ok) return { path: "body", message: check.message };
  if (value.isDefault && kind !== SNIPPET_KIND_WITH_VARIABLES) {
    return { path: "isDefault", message: SNIPPET_DEFAULT_ONLY_EMAIL_MESSAGE };
  }
  return null;
}

function addKindIssues(
  value: { kind: SnippetKind; body: string; isDefault: boolean },
  ctx: z.RefinementCtx,
) {
  const problem = checkKindRules(value.kind, value);
  if (problem) ctx.addIssue({ code: "custom", path: [problem.path], message: problem.message });
}

/** Crear un texto guardado. El identificador lo genera la aplicación (así un doble clic no duplica). */
export const createSnippetSchema = z
  .object({
    id: z.uuid(),
    kind: snippetKindSchema,
    name: snippetNameSchema,
    body: snippetBodySchema,
    isDefault: z.boolean(),
  })
  .strict()
  .superRefine(addKindIssues);

/**
 * Cambiar un texto guardado. El tipo no se cambia nunca y no se manda: las variables y el «texto inicial» se
 * revisan aparte con `checkKindRules` y el tipo guardado, y la base vuelve a revisarlos con el tipo de la fila.
 */
export const updateSnippetSchema = z
  .object({
    id: z.uuid(),
    expectedRevision: z.number().int().min(1).max(SNIPPET_REVISION_MAX),
    name: snippetNameSchema,
    body: snippetBodySchema,
    isDefault: z.boolean(),
  })
  .strict();

export const deleteSnippetSchema = z.object({ id: z.uuid() }).strict();

export type CreateSnippetInput = z.infer<typeof createSnippetSchema>;
export type UpdateSnippetInput = z.infer<typeof updateSnippetSchema>;
