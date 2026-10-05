/**
 * Lo que la pantalla le manda al servidor al guardar un borrador, validado con zod ANTES de calcular
 * (el servidor nunca confía en el navegador). Enteros de punta a punta: cantidad en milésimas,
 * porcentajes en puntos base, pesos enteros.
 */

import { z } from "zod";
import { CATALOG_UNITS } from "@/lib/catalog/schemas";
import { MAX_CLP } from "@/lib/money/clp";
import { PERCENT_MAX_BP, QUANTITY_MAX_MILLI, QUANTITY_MIN_MILLI, QUOTE_MAX_LINES } from "./calc";
import {
  isValidIsoDate,
  QUOTE_TEXT_MAX_LENGTH,
  VALIDITY_DAYS_MAX,
  VALIDITY_DAYS_MIN,
} from "./validity";

export const QUOTE_ITEM_NAME_MAX_LENGTH = 150;
export const QUOTE_ITEM_DESCRIPTION_MAX_LENGTH = 2000;

const unitValues = CATALOG_UNITS.map((unit) => unit.value) as [string, ...string[]];

const discountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("percent"),
      bp: z.number().int().min(0).max(PERCENT_MAX_BP, "El porcentaje no puede pasar de 100%."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("amount"),
      clp: z.number().int().min(0, "El descuento no puede ser negativo.").max(MAX_CLP),
    })
    .strict(),
]);

export const quoteItemSchema = z
  .object({
    id: z.uuid(),
    catalogItemId: z.uuid().nullable(),
    name: z
      .string()
      .trim()
      .min(1, "Escribe el nombre de la línea.")
      .max(QUOTE_ITEM_NAME_MAX_LENGTH, "El nombre es demasiado largo."),
    description: z
      .string()
      .trim()
      .max(QUOTE_ITEM_DESCRIPTION_MAX_LENGTH, "La descripción es demasiado larga.")
      .nullable(),
    unit: z.enum(unitValues, { error: "Elige una unidad." }),
    taxTreatment: z.enum(["taxable", "exempt"]),
    quantityMilli: z
      .number()
      .int()
      .min(QUANTITY_MIN_MILLI, "La cantidad debe ser mayor que 0.")
      .max(QUANTITY_MAX_MILLI, "La cantidad es demasiado grande."),
    unitPriceClp: z.number().int().min(0, "El precio no puede ser negativo.").max(MAX_CLP),
    discount: discountSchema,
  })
  .strict();

const validitySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("days"),
      days: z
        .number()
        .int("La vigencia se cuenta en días enteros.")
        .min(VALIDITY_DAYS_MIN, "La vigencia mínima es 1 día.")
        .max(VALIDITY_DAYS_MAX, "La vigencia máxima es 365 días."),
    })
    .strict(),
  z
    .object({
      mode: z.literal("date"),
      date: z.string().refine(isValidIsoDate, "Elige una fecha válida."),
    })
    .strict(),
]);

/** Observaciones y condiciones: texto simple (nunca HTML); vacío = sin texto. */
const quoteTextSchema = z
  .string()
  .trim()
  .max(QUOTE_TEXT_MAX_LENGTH, "El texto es demasiado largo (máximo 4.000 caracteres).")
  .nullable();

export const saveQuotePayloadSchema = z
  .object({
    saveId: z.uuid(),
    expectedRevision: z.number().int().min(1).max(2_147_483_647),
    customerId: z.uuid(),
    globalDiscount: discountSchema,
    validity: validitySchema,
    observations: quoteTextSchema,
    conditions: quoteTextSchema,
    items: z.array(quoteItemSchema).max(QUOTE_MAX_LINES, "Una cotización admite hasta 200 líneas."),
  })
  .strict();

export type SaveQuotePayload = z.infer<typeof saveQuotePayloadSchema>;
export type QuoteItemPayload = z.infer<typeof quoteItemSchema>;

/** Errores de zod -> mensajes por campo con la llave `items.3.quantityMilli`, `globalDiscount`, etc. */
export function payloadFieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "payload";
    errors[key] ??= issue.message;
  }
  return errors;
}
