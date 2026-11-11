/** Traduce los errores de Supabase Auth a mensajes en español de Chile, sin revelar si una cuenta existe. */

export type AuthFailureKind =
  | "rate_limited"
  | "weak_password"
  | "same_password"
  | "reauthentication_needed"
  | "invalid_credentials"
  | "email_not_confirmed"
  | "mfa_invalid_code"
  | "mfa_expired"
  | "mfa_code_reused"
  | "mfa_unavailable"
  | "unknown";

type AuthErrorLike = { code?: string | null; status?: number | null };

const RATE_LIMIT_CODES = new Set(["over_request_rate_limit", "over_email_send_rate_limit"]);
const HTTP_TOO_MANY_REQUESTS = 429;

export function classifyAuthError(error: AuthErrorLike): AuthFailureKind {
  if (error.status === HTTP_TOO_MANY_REQUESTS || (error.code && RATE_LIMIT_CODES.has(error.code))) {
    return "rate_limited";
  }
  if (error.code === "weak_password") return "weak_password";
  if (error.code === "same_password") return "same_password";
  if (error.code === "reauthentication_needed") return "reauthentication_needed";
  if (error.code === "invalid_credentials") return "invalid_credentials";
  if (error.code === "email_not_confirmed") return "email_not_confirmed";
  // Verificación en dos pasos (H-004a). `mfa_code_reused` no lo entrega Supabase: lo decide el bloqueo propio de códigos usados.
  if (error.code === "mfa_verification_failed") return "mfa_invalid_code";
  if (error.code === "mfa_challenge_expired" || error.code === "mfa_factor_not_found") {
    return "mfa_expired";
  }
  if (error.code === "insufficient_aal" || error.code === "mfa_ip_address_mismatch") {
    return "mfa_unavailable";
  }
  return "unknown";
}

export const AUTH_MESSAGES: Record<AuthFailureKind, string> = {
  rate_limited: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
  weak_password:
    "Esa contraseña es muy fácil de adivinar. Prueba con otra más larga o más variada.",
  same_password: "La contraseña nueva tiene que ser distinta de la actual.",
  reauthentication_needed:
    "Por seguridad, pide un enlace nuevo para cambiar tu contraseña y ábrelo de inmediato.",
  invalid_credentials: "Correo o contraseña incorrectos.",
  email_not_confirmed:
    "Todavía no verificas tu correo. Abre el enlace que te enviamos al registrarte y luego ingresa.",
  mfa_invalid_code:
    "El código no coincide. Escribe el que muestra ahora tu aplicación (cambia cada 30 segundos) y revisa que la hora de tu teléfono esté al día.",
  mfa_expired: "La activación caducó. Vuelve a empezar.",
  mfa_code_reused: "Ese código ya se usó. Espera el siguiente.",
  mfa_unavailable: "No pudimos verificar el código. Intenta de nuevo en unos minutos.",
  unknown: "No pudimos completar la acción. Intenta de nuevo en unos minutos.",
};

/** Bloqueo de 24 horas por demasiados códigos incorrectos en el día (H-004a): no es cuestión de esperar unos minutos. */
export const MFA_LOCKED_DAY_MESSAGE =
  "Demasiados intentos hoy. Vuelve a intentarlo mañana o pide ayuda al equipo de Cotiza Prime.";

/** Al ingresar, la verificación no se pudo completar por algo que no es el código (la sesión o el factor cambiaron). */
export const MFA_SIGN_IN_FAILED_MESSAGE =
  "No pudimos verificar el código. Cierra sesión y vuelve a ingresar.";
