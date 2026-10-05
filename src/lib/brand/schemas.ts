import { z } from "zod";
import { normalizeHexColor } from "./colors";

const colorField = (label: string) =>
  z
    .string({ error: `Elige el color ${label}.` })
    .trim()
    .min(1, `Elige el color ${label}.`)
    .transform((value, context) => {
      const hex = normalizeHexColor(value);
      if (hex === null) {
        context.addIssue({
          code: "custom",
          message: `El color ${label} no es válido. Usa el formato #2B54E0.`,
        });
        return z.NEVER;
      }
      return hex;
    });

export const brandColorsSchema = z.object({
  primaryColor: colorField("principal"),
  secondaryColor: colorField("secundario"),
});

export type BrandColorsInput = z.infer<typeof brandColorsSchema>;
