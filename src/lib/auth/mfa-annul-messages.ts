/** Los mensajes de la página para anular la activación del segundo paso (H-118b). Un solo lugar, sin servidor. */
export const MFA_ANNUL_INVALID_MESSAGE =
  "Este enlace ya no sirve. Si alguien activó la verificación en tu cuenta sin tu permiso, escríbenos.";
export const MFA_ANNUL_FAILED_MESSAGE =
  "No pudimos terminar. Abre de nuevo el enlace en unos minutos.";
export const MFA_ANNUL_DONE_MESSAGE =
  "Anulamos la activación y cerramos todas las sesiones. Te enviamos un correo para elegir tu contraseña nueva. Ábrelo en este mismo navegador.";
export const MFA_ANNUL_DONE_NO_EMAIL_MESSAGE =
  "Anulamos la activación y cerramos todas las sesiones. Para entrar, usa «¿Olvidaste tu contraseña?».";

/** El código del enlace no llegó a la página (se recargó o se abrió la dirección sin el «#»): no se envía nada y no se dice nada del enlace. */
export const MFA_ANNUL_MISSING_CODE_MESSAGE = "Abre otra vez el botón del correo.";
