import { z } from "zod";

/** Largo mínimo de la contraseña. Debe coincidir con `minimum_password_length` de supabase/config.toml. */
export const PASSWORD_MIN_LENGTH = 10;
/** Tope práctico del algoritmo de contraseñas; evita enviar textos enormes. */
export const PASSWORD_MAX_LENGTH = 72;
export const NAME_MAX_LENGTH = 120;
export const EMAIL_MAX_LENGTH = 254;

const emailField = z
  .string({ error: "Ingresa tu correo." })
  .trim()
  .toLowerCase()
  .min(1, "Ingresa tu correo.")
  .max(EMAIL_MAX_LENGTH, "El correo es demasiado largo.")
  .pipe(z.email({ error: "Revisa el correo: no parece una dirección válida." }));

export const signUpSchema = z.object({
  fullName: z
    .string({ error: "Ingresa tu nombre." })
    .trim()
    .min(1, "Ingresa tu nombre.")
    .max(NAME_MAX_LENGTH, "El nombre es demasiado largo."),
  email: emailField,
  password: z
    .string({ error: "Ingresa una contraseña." })
    .min(
      PASSWORD_MIN_LENGTH,
      `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`,
    )
    .max(PASSWORD_MAX_LENGTH, `La contraseña puede tener hasta ${PASSWORD_MAX_LENGTH} caracteres.`),
  acceptLegal: z.literal("on", {
    error: "Para crear tu cuenta debes aceptar los términos y la política de privacidad.",
  }),
});

export const signInSchema = z.object({
  email: emailField,
  password: z
    .string({ error: "Ingresa tu contraseña." })
    .min(1, "Ingresa tu contraseña.")
    .max(PASSWORD_MAX_LENGTH, "Correo o contraseña incorrectos."),
});

export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const flat = z.flattenError(error).fieldErrors as Record<string, string[] | undefined>;
  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(flat)) {
    if (messages?.[0]) result[field] = messages[0];
  }
  return result;
}
