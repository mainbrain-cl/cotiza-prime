/** Direcciones de las pantallas de cuenta. Un solo lugar para no repetir textos. */
export const HOME_PATH = "/";
export const LOGIN_PATH = "/ingresar";
export const SIGNUP_PATH = "/registro";
export const ACCEPT_TERMS_PATH = "/aceptar-terminos";
export const FORGOT_PASSWORD_PATH = "/recuperar-contrasena";
export const RESET_PASSWORD_PATH = "/restablecer-contrasena";
export const NEW_TENANT_PATH = "/organizaciones/nueva";
/** Pantalla donde se escribe el código de 6 números tras la contraseña (H-004a). Única que acepta sesión parcial. */
export const SECOND_STEP_PATH = "/ingresar/codigo";
/** Pantalla de la cuenta donde se activa la verificación en dos pasos (H-004a). */
export const ACCOUNT_SECURITY_PATH = "/cuenta/seguridad";
/** Dirección a la que llega el enlace del correo de verificación. */
export const AUTH_CALLBACK_PATH = "/auth/callback";
/** Dirección a la que llega el enlace del correo de restablecer contraseña. */
export const AUTH_RECOVERY_PATH = "/auth/recuperar";
export const TERMS_PATH = "/terminos";
export const PRIVACY_PATH = "/privacidad";

/** Avisos que puede traer `/ingresar?aviso=...` (los muestra la pantalla de ingreso). */
export const LOGIN_NOTICES = {
  linkNotUsable: "enlace-no-valido",
  linkExpired: "enlace-vencido",
  signedOut: "sesion-cerrada",
  signOutIncomplete: "cierre-incompleto",
  resetLinkExpired: "enlace-recuperacion-vencido",
} as const;

/** Avisos que puede traer `/cuenta/seguridad?aviso=...`. */
export const ACCOUNT_SECURITY_NOTICES = {
  enabled: "activada",
  /** Se crearon códigos de respaldo nuevos desde la pantalla de seguridad (H-004b). */
  codesCreated: "codigos",
  /** Se entró con un código de respaldo: la verificación quedó desactivada y hay que activarla de nuevo (H-004b). */
  recoveryUsed: "respaldo",
  /** La persona desactivó la verificación en dos pasos desde la pantalla de seguridad (H-004b). */
  disabled: "desactivada",
} as const;
