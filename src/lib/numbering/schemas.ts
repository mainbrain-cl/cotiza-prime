import { z } from "zod";
import { NUMBERING_MODES } from "./format";

export const PREFIX_MAX_LENGTH = 8;
/** Tope razonable para el número de partida (cabe en un `bigint` y en el PDF). */
export const START_NUMBER_MAX = 99_999_999;

export const numberingSchema = z.object({
  prefix: z
    .string({ error: "Ingresa el prefijo." })
    .trim()
    .toUpperCase()
    .min(1, "Ingresa el prefijo, por ejemplo COT.")
    .regex(
      /^[A-Z0-9]{1,8}$/,
      `El prefijo debe tener de 1 a ${PREFIX_MAX_LENGTH} letras o números, sin espacios ni símbolos.`,
    ),
  mode: z.enum(NUMBERING_MODES, { error: "Elige cómo se reinicia el correlativo." }),
  startNumber: z
    .string({ error: "Ingresa el número de partida." })
    .trim()
    .regex(/^\d+$/, "El número de partida debe ser un número entero, sin puntos ni letras.")
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(1, "El número de partida debe ser 1 o más.")
        .max(START_NUMBER_MAX, "El número de partida es demasiado grande."),
    ),
});

export type NumberingInput = z.infer<typeof numberingSchema>;
