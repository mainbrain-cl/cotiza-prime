/** Direcciones de las pantallas de cuenta. Un solo lugar para no repetir textos. */
export const HOME_PATH = "/";
export const LOGIN_PATH = "/ingresar";
export const SIGNUP_PATH = "/registro";
export const ACCEPT_TERMS_PATH = "/aceptar-terminos";
export const FORGOT_PASSWORD_PATH = "/recuperar-contrasena";
export const RESET_PASSWORD_PATH = "/restablecer-contrasena";
export const NEW_TENANT_PATH = "/organizaciones/nueva";
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
