import { z } from "zod";
import type { FormState } from "@/lib/auth/form-state";

/**
 * Terminar de crear la cuenta (H-116), sin base de datos ni servidor: lo que responden las funciones de la base, lo que se le
 * dice a la persona por cada resultado y los textos fijos de las pantallas del registro en dos pasos.
 *
 * Las funciones de la base (`complete_account_setup` y `account_setup_preflight`) RESPONDEN los rechazos en vez de lanzarlos
 * (un error revertiría la fila de auditoría): aquí cada resultado tiene su mensaje. Los textos son los de
 * `docs/arquitectura/h-116-registro-seguro.md` §3.3; ninguno promete algo que no existe.
 */

/** Los resultados de `complete_account_setup` y `account_setup_preflight`. */
export const SETUP_RESULTS = [
  "ok",
  "completed",
  "not_email_link",
  "unverified",
  "email_changed",
  "factor_present",
  "invalid_name",
  "legal_changed",
  "other_sessions",
] as const;
export type SetupResult = (typeof SETUP_RESULTS)[number];

export const setupResponseSchema = z.object({
  result: z.enum(SETUP_RESULTS),
  already_ready: z.boolean().optional(),
});

/** Lo que devuelven las acciones de `/crear-cuenta` a la pantalla. `expired`: el enlace ya no sirve y hay que pedir otro. */
export type CreateAccountState = FormState & { expired?: boolean };

export const INITIAL_CREATE_ACCOUNT_STATE: CreateAccountState = { status: "idle" };

/** Lo que devuelve «Continuar» (canjear el enlace) a la pantalla. */
export type ConfirmEmailState = {
  status: "idle" | "error";
  message?: string;
  /** El enlace ya no sirve (se usó, venció o está mal escrito): la pantalla ofrece pedir uno nuevo en vez de reintentar. */
  expired?: boolean;
};

export const INITIAL_CONFIRM_EMAIL_STATE: ConfirmEmailState = { status: "idle" };

// --- /registro ---------------------------------------------------------------------------------------------------------------

/** La acción con que se muestra la prueba anti-robot de `/registro` (el servidor la vuelve a comprobar). */
export const SIGNUP_ANTIBOT_ACTION = "signup";
/**
 * Duración mínima de la respuesta de `/registro`: pase lo que pase, la persona espera al menos esto. Tapa cualquier diferencia
 * de tiempo entre un correo con cuenta y uno sin cuenta (la etapa 0 midió 120 ms frente a 17 ms en el trabajo caro, que además
 * corre DESPUÉS de responder).
 */
export const SIGNUP_MIN_RESPONSE_MS = 800;

/** Lo que dice la pantalla al enviar el correo: igual exista o no la cuenta (sin revelar quién tiene una). */
export const SIGNUP_SENT_SUFFIX =
  "Ábrelo dentro de una hora. Si ya tenías una cuenta con este correo, ingresa o recupera tu contraseña.";

/**
 * Quien ya confirmó su correo y no terminó la cuenta no recibe otro enlace de registro (decisión A2: si el correo ya tiene una
 * cuenta verificada no se envía nada, para no revelar quién tiene cuenta): su camino es «¿Olvidaste tu contraseña?», que la lleva
 * a terminar la cuenta. Lo dicen las pantallas donde un enlace ya no sirve.
 */
export const VERIFIED_NOT_FINISHED_HELP =
  "Si ya habías confirmado tu correo, usa «¿Olvidaste tu contraseña?»: te enviamos un enlace para terminar tu cuenta.";

// --- /confirmar-correo -------------------------------------------------------------------------------------------------------

export const CONFIRM_EXPIRED_TITLE = "Este enlace ya se usó o venció";
export const CONFIRM_EXPIRED_TEXT =
  "Por seguridad, cada enlace sirve una sola vez y vale una hora. Pide uno nuevo para seguir.";
/** Canjear el enlace falló por algo que no es el enlace (sin red, o Supabase no respondió): se puede volver a intentar. */
export const CONFIRM_RETRY_MESSAGE =
  "No pudimos confirmar tu correo en este momento. Inténtalo de nuevo en unos minutos.";

// --- /crear-cuenta -----------------------------------------------------------------------------------------------------------

export const SETUP_EXPIRED_MESSAGE =
  "Tu enlace venció o ya se usó. Pide uno nuevo para terminar tu cuenta.";
export const SETUP_FAILED_MESSAGE =
  "No pudimos terminar de crear tu cuenta. Inténtalo de nuevo en unos minutos.";
const SETUP_SUPPORT_SUFFIX = "Escribe al equipo de Cotiza Prime para resolverlo.";

export type SetupRejection = {
  message: string;
  /** El enlace ya no sirve: la pantalla ofrece pedir uno nuevo en vez de reintentar. */
  expired?: boolean;
  /** El error es de un campo, no de la cuenta. */
  field?: "fullName";
};

/** Qué se le dice a la persona por cada rechazo de la base. `completed`, `ok` y `other_sessions` no están: no son rechazos finales. */
export const SETUP_REJECTIONS: Readonly<
  Record<Exclude<SetupResult, "ok" | "completed" | "other_sessions">, SetupRejection>
> = {
  not_email_link: { message: SETUP_EXPIRED_MESSAGE, expired: true },
  unverified: {
    message:
      "Primero confirma tu correo con el enlace que te enviamos. Si no lo encuentras, pide uno nuevo.",
    expired: true,
  },
  email_changed: {
    message: `El correo de esta cuenta cambió, así que no podemos terminar de crearla. ${SETUP_SUPPORT_SUFFIX}`,
  },
  factor_present: {
    message: `Esta cuenta ya tenía una verificación en dos pasos puesta antes de que la terminaras. Por seguridad no podemos continuar. ${SETUP_SUPPORT_SUFFIX}`,
  },
  invalid_name: {
    message: "Revisa tu nombre: tiene que tener entre 1 y 120 caracteres y nada raro.",
    field: "fullName",
  },
  legal_changed: {
    message:
      "Actualizamos los términos o la política de privacidad mientras llenabas el formulario. Recarga la página, léelos y acepta de nuevo.",
  },
};

/** Si tras cerrar las otras sesiones y reintentar la base sigue viendo otra sesión abierta. */
export const OTHER_SESSIONS_MESSAGE =
  "Hay otra sesión abierta en tu cuenta y no pudimos cerrarla. Inténtalo de nuevo en unos minutos.";

/** Un resultado que no se conoce (la base respondió algo inesperado): nunca se muestra como éxito. */
export function rejectionFor(result: SetupResult): SetupRejection {
  if (result === "other_sessions") return { message: OTHER_SESSIONS_MESSAGE };
  if (result === "ok" || result === "completed") return { message: SETUP_FAILED_MESSAGE };
  return SETUP_REJECTIONS[result];
}

/** El estado de error de «Crear mi cuenta» para un rechazo, con lo escrito (nunca la contraseña). */
export function rejectionState(
  rejection: SetupRejection,
  values: Record<string, string>,
): CreateAccountState {
  return {
    status: "error",
    ...(rejection.field
      ? { fieldErrors: { [rejection.field]: rejection.message } }
      : { message: rejection.message }),
    ...(rejection.expired ? { expired: true } : {}),
    values,
  };
}
