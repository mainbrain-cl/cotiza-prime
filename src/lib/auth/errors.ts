/** Traduce los errores de Supabase Auth a mensajes en español de Chile, sin revelar si una cuenta existe. */

export type AuthFailureKind =
  "rate_limited" | "weak_password" | "invalid_credentials" | "email_not_confirmed" | "unknown";

type AuthErrorLike = { code?: string | null; status?: number | null };

const RATE_LIMIT_CODES = new Set(["over_request_rate_limit", "over_email_send_rate_limit"]);
const HTTP_TOO_MANY_REQUESTS = 429;

export function classifyAuthError(error: AuthErrorLike): AuthFailureKind {
  if (error.status === HTTP_TOO_MANY_REQUESTS || (error.code && RATE_LIMIT_CODES.has(error.code))) {
    return "rate_limited";
  }
  if (error.code === "weak_password") return "weak_password";
  if (error.code === "invalid_credentials") return "invalid_credentials";
  if (error.code === "email_not_confirmed") return "email_not_confirmed";
  return "unknown";
}

export const AUTH_MESSAGES: Record<AuthFailureKind, string> = {
  rate_limited: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
  weak_password:
    "Esa contraseña es muy fácil de adivinar. Prueba con otra más larga o más variada.",
  invalid_credentials: "Correo o contraseña incorrectos.",
  email_not_confirmed:
    "Todavía no verificas tu correo. Abre el enlace que te enviamos al registrarte y luego ingresa.",
  unknown: "No pudimos completar la acción. Intenta de nuevo en unos minutos.",
};
