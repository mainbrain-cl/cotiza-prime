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

/** H-116, paso 1 del registro: solo el correo (y la prueba anti-robot). Nada de contraseña, nombre ni términos todavía. */
export const ANTIBOT_TOKEN_MAX_LENGTH = 2_048;
export const ANTIBOT_MISSING_MESSAGE = "Confirma que no eres un robot.";

export const signUpSchema = z.object({
  email: emailField,
  antibotToken: z
    .string({ error: ANTIBOT_MISSING_MESSAGE })
    .min(1, ANTIBOT_MISSING_MESSAGE)
    .max(ANTIBOT_TOKEN_MAX_LENGTH, ANTIBOT_MISSING_MESSAGE),
});

/** Largo máximo de las versiones de los documentos legales que viajan en el formulario (son del estilo `2026-10-01-preliminar`). */
const LEGAL_VERSION_MAX_LENGTH = 64;
/** Caracteres de control: la base los rechaza en el nombre (`complete_account_setup`). */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const newPasswordField = z
  .string({ error: "Ingresa una contraseña." })
  .min(PASSWORD_MIN_LENGTH, `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`)
  .max(PASSWORD_MAX_LENGTH, `La contraseña puede tener hasta ${PASSWORD_MAX_LENGTH} caracteres.`);

/**
 * H-116, paso 2: terminar de crear la cuenta (desde la sesión del enlace del correo). Las versiones de términos y privacidad
 * son las que la pantalla mostró; la base las compara con las vigentes y, si cambiaron mientras tanto, responde
 * `legal_changed`.
 */
export const createAccountSchema = z
  .object({
    fullName: z
      .string({ error: "Ingresa tu nombre." })
      .trim()
      .min(1, "Ingresa tu nombre.")
      .max(NAME_MAX_LENGTH, "El nombre es demasiado largo.")
      .refine(
        (value) => !CONTROL_CHARACTERS.test(value),
        "Revisa tu nombre: tiene caracteres que no podemos guardar.",
      ),
    password: newPasswordField,
    confirmPassword: z.string({ error: "Repite la contraseña." }),
    acceptLegal: z.literal("on", {
      error: "Para crear tu cuenta debes aceptar los términos y la política de privacidad.",
    }),
    termsVersion: z.string().min(1).max(LEGAL_VERSION_MAX_LENGTH),
    privacyVersion: z.string().min(1).max(LEGAL_VERSION_MAX_LENGTH),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    error: "Las contraseñas no coinciden.",
  });

export const signInSchema = z.object({
  email: emailField,
  password: z
    .string({ error: "Ingresa tu contraseña." })
    .min(1, "Ingresa tu contraseña.")
    .max(PASSWORD_MAX_LENGTH, "Correo o contraseña incorrectos."),
});

/** Largo del código de la aplicación de verificación (TOTP). */
export const TOTP_CODE_LENGTH = 6;
/** Tope del texto que se acepta antes de limpiarlo (el código se puede pegar con espacios o guiones). */
const TOTP_RAW_MAX_LENGTH = 32;
const TOTP_FORMAT_MESSAGE = `El código tiene ${TOTP_CODE_LENGTH} números. Revisa que no falten ni sobren.`;

/**
 * Código de la verificación en dos pasos (H-004a). Se limpian espacios y guiones («123 456» o «123-456» se pegan tal
 * cual lo muestra la aplicación) y después tiene que haber exactamente 6 dígitos: ninguna letra ni otro símbolo.
 */
export const totpCodeSchema = z.object({
  code: z
    .string({ error: "Escribe el código de 6 números." })
    .max(TOTP_RAW_MAX_LENGTH, TOTP_FORMAT_MESSAGE)
    .transform((value) => value.replace(/[\s-]/g, ""))
    .pipe(
      z
        .string()
        .min(1, "Escribe el código de 6 números.")
        .regex(new RegExp(`^[0-9]{${TOTP_CODE_LENGTH}}$`), TOTP_FORMAT_MESSAGE),
    ),
});

/**
 * La contraseña que se vuelve a pedir dentro de una sesión (H-004b). Solo se mira que venga y que no sea más larga de lo
 * que acepta el sistema (una más larga no puede ser la correcta y ni se consulta a Supabase); si es incorrecta lo dice la
 * comprobación contra Supabase, no este esquema.
 */
export const reauthPasswordSchema = z.object({
  password: z
    .string({ error: "Ingresa tu contraseña." })
    .min(1, "Ingresa tu contraseña.")
    .max(PASSWORD_MAX_LENGTH, "La contraseña no es correcta."),
});

export const forgotPasswordSchema = z.object({ email: emailField });

export const resetPasswordSchema = z
  .object({
    password: z
      .string({ error: "Ingresa una contraseña." })
      .min(
        PASSWORD_MIN_LENGTH,
        `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`,
      )
      .max(
        PASSWORD_MAX_LENGTH,
        `La contraseña puede tener hasta ${PASSWORD_MAX_LENGTH} caracteres.`,
      ),
    confirmPassword: z.string({ error: "Repite la contraseña." }),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    error: "Las contraseñas no coinciden.",
  });

export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const flat = z.flattenError(error).fieldErrors as Record<string, string[] | undefined>;
  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(flat)) {
    if (messages?.[0]) result[field] = messages[0];
  }
  return result;
}
