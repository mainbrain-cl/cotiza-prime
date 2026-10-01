import { z } from "zod";
import { isValidRut } from "@/lib/rut";

export const INDUSTRIES = [
  { value: "logistics", label: "Logística y transporte" },
  { value: "services", label: "Servicios" },
  { value: "products", label: "Venta de productos" },
  { value: "construction", label: "Construcción" },
  { value: "events", label: "Eventos" },
  { value: "other", label: "Otro" },
] as const;

const INDUSTRY_VALUES = INDUSTRIES.map((industry) => industry.value) as [
  (typeof INDUSTRIES)[number]["value"],
  ...(typeof INDUSTRIES)[number]["value"][],
];

export const TENANT_NAME_MIN_LENGTH = 2;
export const TENANT_NAME_MAX_LENGTH = 120;
export const CONTACT_PHONE_MAX_LENGTH = 30;
export const CONTACT_EMAIL_MAX_LENGTH = 254;

export const createTenantSchema = z.object({
  name: z
    .string({ error: "Ingresa el nombre de tu empresa." })
    .trim()
    .min(TENANT_NAME_MIN_LENGTH, "El nombre debe tener al menos 2 caracteres.")
    .max(TENANT_NAME_MAX_LENGTH, "El nombre es demasiado largo."),
  rut: z
    .string({ error: "Ingresa el RUT de la empresa." })
    .trim()
    .min(1, "Ingresa el RUT de la empresa.")
    .refine(isValidRut, "El RUT no es válido. Revisa el número y el dígito verificador."),
  industry: z.enum(INDUSTRY_VALUES, { error: "Elige el rubro de tu empresa." }),
  contactEmail: z
    .string()
    .trim()
    .max(CONTACT_EMAIL_MAX_LENGTH, "El correo de contacto es demasiado largo.")
    .refine(
      (value) => value === "" || z.email().safeParse(value).success,
      "Revisa el correo de contacto.",
    )
    .transform((value) => (value === "" ? null : value)),
  contactPhone: z
    .string()
    .trim()
    .max(CONTACT_PHONE_MAX_LENGTH, "El teléfono es demasiado largo.")
    .transform((value) => (value === "" ? null : value)),
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
