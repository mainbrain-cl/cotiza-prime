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
  mfa_expired: "La activación caducó. Recarga la página y vuelve a empezar.",
  mfa_code_reused: "Ese código ya se usó. Espera el siguiente.",
  mfa_unavailable: "No pudimos verificar el código. Intenta de nuevo en unos minutos.",
  unknown: "No pudimos completar la acción. Intenta de nuevo en unos minutos.",
};

/**
 * Bloqueo de 24 horas por demasiados códigos incorrectos en el día (H-004a): no es cuestión de esperar unos minutos. Es el
 * mensaje del camino de recuperación por correo, donde ya se entró con un enlace del correo y no hay contraseña que cambiar.
 */
export const MFA_LOCKED_DAY_MESSAGE =
  "Demasiados intentos hoy. Vuelve a intentarlo mañana o pide ayuda al equipo de Cotiza Prime.";

/**
 * El mismo bloqueo en el camino CON CONTRASEÑA: quien llegó al código con la contraseña sola puede no ser la dueña de la
 * cuenta, así que el texto orienta a entrar con un enlace al correo y cambiarla (eso limpia estos contadores).
 */
export const MFA_LOCKED_DAY_PASSWORD_MESSAGE =
  "Demasiados intentos. Si no fuiste tú, alguien puede tener tu contraseña: usa «¿Olvidaste tu contraseña?» para entrar con un enlace a tu correo y cámbiala.";

/**
 * El mismo bloqueo de 24 horas pero al ACTIVAR la verificación (menor 4 de la revisión de Aarón al PR #44): ahí lo más probable
 * es la hora del teléfono, no que alguien tenga la contraseña, así que el texto orienta a revisarla.
 */
export const MFA_LOCKED_DAY_ENROLLMENT_MESSAGE =
  "Demasiados intentos hoy. Revisa que la fecha y la hora de tu teléfono estén en automático e inténtalo de nuevo mañana. Si sigue fallando, pide ayuda al equipo de Cotiza Prime.";

/**
 * El mismo bloqueo de 24 horas pero al CREAR códigos de respaldo (o, más adelante, desactivar la verificación) con la sesión
 * ya abierta (H-004b): quien escribe aquí ya entró, así que el texto orienta a esperar y, si no fue la persona, a cambiar la
 * contraseña.
 */
export const MFA_LOCKED_DAY_MANAGE_MESSAGE =
  "Demasiados intentos hoy. Vuelve a intentarlo mañana. Si no fuiste tú, cambia tu contraseña y pide ayuda al equipo de Cotiza Prime.";

/**
 * El MISMO mensaje para cualquier causa por la que un código de respaldo no sirve (no existe, ya se usó, está en uso, la cuenta
 * no tiene códigos): no revela cuál fue. Lo usan entrar con un código y desactivar la verificación (H-004b).
 */
export const RECOVERY_CODE_INVALID_MESSAGE =
  "Ese código de respaldo no sirve. Revisa cómo lo escribiste; cada código sirve una sola vez.";

/**
 * Al DESACTIVAR la verificación en dos pasos, el correo de aviso no pudo salir (H-004b, D4 = A): como al activar, sin el aviso no
 * se cambia nada, para que la dueña de la cuenta no quede sin enterarse.
 */
export const MFA_DISABLE_NOTICE_FAILED_MESSAGE =
  "No pudimos enviarte el correo de aviso, así que no desactivamos la verificación. Inténtalo de nuevo en unos minutos.";

/** Al ingresar, la verificación no se pudo completar por algo que no es el código (la sesión o el factor cambiaron). */
export const MFA_SIGN_IN_FAILED_MESSAGE =
  "No pudimos verificar el código. Cierra sesión y vuelve a ingresar.";

/**
 * Al activar la verificación en dos pasos, el correo de aviso (con el enlace para anular la activación) no pudo salir
 * (H-118a). La activación se revierte: dejarla activa sin que nadie fuera avisado no protege a la dueña de la cuenta.
 */
export const MFA_NOTICE_REVERTED_MESSAGE =
  "No pudimos enviarte el correo de aviso, así que no dejamos activa la verificación. Inténtalo de nuevo en unos minutos.";

/** El aviso no salió Y tampoco se pudo desactivar lo recién activado: la persona tiene que pedir ayuda. */
export const MFA_NOTICE_REVERT_FAILED_MESSAGE =
  "No pudimos enviarte el correo de aviso y la verificación quedó activa sin él. Escribe al equipo de Cotiza Prime para resolverlo.";
