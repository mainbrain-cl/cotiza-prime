import { z } from "zod";
import {
  FORM_INTRO_MAX,
  FORM_ITEM_DESCRIPTION_MAX,
  FORM_ITEM_NAME_MAX,
  FORM_ITEMS_MAX,
  FORM_NAME_MAX,
  FORM_POLICY_URL_MAX,
  FORM_SUCCESS_MAX,
  FORM_TITLE_MAX,
  ITEM_UNITS,
  type EditorForm,
} from "./builder-model";
import { MULTI_LINE_UNSAFE, SINGLE_LINE_UNSAFE, hasLoneSurrogate } from "./unsafe-text";

/**
 * Validación del formulario del constructor (H-086). Corre en el navegador (para avisar al escribir)
 * y otra vez en el servidor. La base vuelve a comprobar todo: esto solo da mensajes claros.
 */

const UNSAFE_MESSAGE = "Quita los caracteres especiales o invisibles; escribe solo texto normal.";

function line(label: string, max: number) {
  return z
    .string({ error: `Escribe ${label}.` })
    .trim()
    .min(1, `Escribe ${label}.`)
    .max(max, `Es demasiado largo (máximo ${max} caracteres).`)
    .refine((v) => !SINGLE_LINE_UNSAFE.test(v) && !hasLoneSurrogate(v), UNSAFE_MESSAGE);
}

function multiline(max: number) {
  return z
    .string()
    .transform((v) => v.replace(/\r/g, "").trim())
    .pipe(
      z
        .string()
        .max(max, `Es demasiado largo (máximo ${max} caracteres).`)
        .refine((v) => !MULTI_LINE_UNSAFE.test(v) && !hasLoneSurrogate(v), UNSAFE_MESSAGE),
    );
}

/** Misma regla que la base: https, con dominio, sin espacios ni caracteres que rompan un atributo. */
const POLICY_URL_PATTERN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::[0-9]{1,5})?(?:[/?#][^\s"'<>\\^`{|};]*)?$/i;

export const POLICY_URL_MESSAGE =
  "Escribe una dirección que empiece con https:// (por ejemplo, https://tuempresa.cl/privacidad).";

/** ¿Es una dirección de política de privacidad aceptable (https, sin caracteres peligrosos)? */
export function isValidPolicyUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length <= FORM_POLICY_URL_MAX && POLICY_URL_PATTERN.test(trimmed);
}

const policyUrl = z
  .string()
  .trim()
  .max(FORM_POLICY_URL_MAX, "La dirección es demasiado larga.")
  .refine((v) => v === "" || POLICY_URL_PATTERN.test(v), POLICY_URL_MESSAGE);

const fieldMode = z.enum(["off", "optional", "required"], { error: "Elige cómo se pide." });
const quantityMode = z.enum(["none", "optional", "required"], { error: "Elige cómo se pide." });
const unitValues = ITEM_UNITS.map((u) => u.value) as [string, ...string[]];
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const milli = z.number().int().min(1).max(1_000_000_000).nullable();

const itemSchema = z
  .object({
    id: uuid,
    kind: z.enum(["catalog", "free"]),
    catalogItemId: uuid.nullable(),
    publicName: line("el nombre del servicio", FORM_ITEM_NAME_MAX),
    publicDescription: multiline(FORM_ITEM_DESCRIPTION_MAX),
    unit: z.enum(unitValues, { error: "Elige una unidad." }),
    quantityMode,
    minQtyMilli: milli,
    maxQtyMilli: milli,
  })
  .strict();

export const editorFormSchema = z
  .object({
    name: line("un nombre interno", FORM_NAME_MAX),
    title: line("el título que verá la persona", FORM_TITLE_MAX),
    intro: multiline(FORM_INTRO_MAX),
    successMessage: multiline(FORM_SUCCESS_MAX),
    fields: z
      .object({
        phone: fieldMode,
        company: fieldMode,
        comuna: fieldMode,
        serviceAddress: fieldMode,
        desiredDate: fieldMode,
        message: fieldMode,
      })
      .strict(),
    privacyPolicyUrl: policyUrl,
    items: z.array(itemSchema).max(FORM_ITEMS_MAX, `Máximo ${FORM_ITEMS_MAX} servicios.`),
  })
  .strict();

export type EditorFormInput = z.infer<typeof editorFormSchema>;

/** Errores por campo con la ruta completa (`items.0.publicName`). Solo el primero de cada campo. */
export function pathErrorsOf(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key !== "" && !(key in result)) result[key] = issue.message;
  }
  return result;
}

/** Valida y devuelve el formulario limpio o los errores por campo. */
export function validateEditorForm(
  form: EditorForm,
): { ok: true; data: EditorFormInput } | { ok: false; errors: Record<string, string> } {
  const parsed = editorFormSchema.safeParse(form);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, errors: pathErrorsOf(parsed.error) };
}

/** Identificador (UUID canónico) de un formulario o de un servicio. */
export function isFormId(value: unknown): value is string {
  return typeof value === "string" && uuid.safeParse(value).success;
}
