/** Direcciones de las pantallas de cuenta. Un solo lugar para no repetir textos. */
export const HOME_PATH = "/";
export const LOGIN_PATH = "/ingresar";
export const SIGNUP_PATH = "/registro";
export const ACCEPT_TERMS_PATH = "/aceptar-terminos";
export const NEW_TENANT_PATH = "/organizaciones/nueva";
/** Dirección a la que llega el enlace del correo de verificación. */
export const AUTH_CALLBACK_PATH = "/auth/callback";
export const TERMS_PATH = "/terminos";
export const PRIVACY_PATH = "/privacidad";

/** Avisos que puede traer `/ingresar?aviso=...` (los muestra la pantalla de ingreso). */
export const LOGIN_NOTICES = {
  verified: "correo-verificado",
  linkExpired: "enlace-vencido",
  signedOut: "sesion-cerrada",
} as const;
