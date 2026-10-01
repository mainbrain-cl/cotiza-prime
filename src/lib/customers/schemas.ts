import { z } from "zod";
import { normalizeRut, parseRut } from "@/lib/chile/rut";
import { normalizeEmail } from "@/lib/normalize/email";
import { isPlausiblePhone } from "@/lib/normalize/phone";

export const CUSTOMER_KINDS = [
  { value: "person", label: "Persona" },
  { value: "company", label: "Empresa" },
] as const;

export type CustomerKind = (typeof CUSTOMER_KINDS)[number]["value"];

export const CUSTOMER_NAME_MAX_LENGTH = 200;
export const CUSTOMER_EMAIL_MAX_LENGTH = 254;
export const CUSTOMER_PHONE_MAX_LENGTH = 30;
export const CUSTOMER_ADDRESS_MAX_LENGTH = 300;
export const CUSTOMER_RUT_MAX_LENGTH = 20;

export const RUT_ERROR = "El RUT no es válido. Revisa el número y el dígito verificador.";

function emptyToNull(value: string): string | null {
  return value === "" ? null : value;
}

/** Lo que llega del formulario. Los campos opcionales vacíos pasan a `null`; RUT y correo quedan normalizados. */
export const customerSchema = z.object({
  kind: z.enum(["person", "company"], { error: "Indica si es una persona o una empresa." }),
  displayName: z
    .string({ error: "Ingresa el nombre del cliente." })
    .trim()
    .min(1, "Ingresa el nombre o la razón social.")
    .max(CUSTOMER_NAME_MAX_LENGTH, "El nombre es demasiado largo."),
  rut: z
    .string()
    .trim()
    .max(CUSTOMER_RUT_MAX_LENGTH, RUT_ERROR)
    .refine((value) => value === "" || parseRut(value) !== null, RUT_ERROR)
    .transform((value) => (value === "" ? null : normalizeRut(value))),
  email: z
    .string()
    .trim()
    .max(CUSTOMER_EMAIL_MAX_LENGTH, "El correo es demasiado largo.")
    .refine((value) => value === "" || z.email().safeParse(value).success, "Revisa el correo.")
    .transform((value) => (value === "" ? null : normalizeEmail(value))),
  phone: z
    .string()
    .trim()
    .max(CUSTOMER_PHONE_MAX_LENGTH, "El teléfono es demasiado largo.")
    .refine((value) => value === "" || isPlausiblePhone(value), "Revisa el teléfono.")
    .transform(emptyToNull),
  address: z
    .string()
    .trim()
    .max(CUSTOMER_ADDRESS_MAX_LENGTH, "La dirección es demasiado larga.")
    .transform(emptyToNull),
});

export type CustomerInput = z.infer<typeof customerSchema>;
