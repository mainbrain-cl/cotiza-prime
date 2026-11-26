import "server-only";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin-client";

/**
 * La PASARELA del registro en dos pasos (H-116). Es el único archivo de `src/lib/auth/` que usa la llave maestra: crea la
 * cuenta SIN contraseña (nadie puede tener una antes de verificar el correo) y entrega el código del enlace que se envía.
 * Una guardia estática vigila que solo llame a `generateLink({ type: "invite" })` y a `updateUserById(id, { password })`, y que
 * nunca use `createUser`, `listUsers`, `deleteUser`, `email_confirm`, `.from(` ni `.rpc(`.
 *
 * El orden es el del diseño (`docs/arquitectura/h-116-registro-seguro.md`, §3.1) y lo comprobó la prueba exploratoria
 * contra GoTrue (etapa 0):
 *  1. `generateLink({ type: "invite" })` obtiene (o CREA, sin contraseña) la cuenta. Su código NO se envía: solo sirve para
 *     tener la cuenta. Si la cuenta ya está verificada, GoTrue responde `email_exists` y aquí se termina SIN enviar nada
 *     (decisión A2: quien ya tiene cuenta usa «Ingresar» o «Olvidaste tu contraseña»).
 *  2. Una contraseña AL AZAR que nadie conoce (`updateUserById`). Neutraliza una contraseña plantada por un registro abierto
 *     por error o por una cuenta antigua sin verificar: confirmar el correo NO la borra. Se hace igual en las cuentas nuevas,
 *     para que los dos casos hagan lo mismo (y `updateUserById` no manda el aviso «tu contraseña cambió»).
 *  3. `generateLink({ type: "invite" })` DE NUEVO. Este es el código que se envía. Va DESPUÉS de la contraseña porque fijar una
 *     contraseña anula los códigos de un solo uso generados antes, y un segundo `generateLink` anula el anterior.
 *
 * Reglas que no se pueden olvidar:
 *  - Nunca se registra ni se devuelve el enlace de GoTrue (`action_link`) ni el código en claro (`email_otp`): solo el
 *    `hashed_token`, con el que nuestra pantalla canjea el enlace, y solo hasta el correo.
 *  - Los errores llevan solo un código: nunca el correo, el código ni lo que respondió GoTrue.
 *  - El enlace que se envía lo arma `signup-service.ts` con `APP_ORIGIN`, nunca esta pasarela ni la petición.
 */

export class SignupGatewayError extends Error {
  readonly code: string;
  constructor(operation: string, code?: string | number | null) {
    const detail = code === null || code === undefined ? "" : `:${String(code)}`;
    super(`signup_gateway_${operation}${detail}`);
    this.name = "SignupGatewayError";
    this.code = detail ? detail.slice(1) : "unknown";
  }
}

/** Resultado de preparar el enlace de registro. */
export type SignupLink =
  /** La cuenta existe (nueva o sin verificar) y este es el código del enlace que hay que enviar. */
  | { status: "ready"; tokenHash: string }
  /** El correo ya tiene una cuenta verificada: no se envía nada. */
  | { status: "already_registered" };

/** GoTrue responde `422 email_exists` al pedir una invitación sobre una cuenta ya verificada. */
const EMAIL_EXISTS_CODES: ReadonlySet<string> = new Set(["email_exists", "user_already_exists"]);

/** Bytes al azar de la contraseña (en base64url son 64 caracteres), más un sufijo que cumple cualquier regla de composición. */
const RANDOM_PASSWORD_BYTES = 48;
const RANDOM_PASSWORD_SUFFIX = "Aa1!";

/** Una contraseña que nadie conoce: ni la persona, ni quien creó la cuenta antes, ni nosotros. */
function randomPassword(): string {
  return `${randomBytes(RANDOM_PASSWORD_BYTES).toString("base64url")}${RANDOM_PASSWORD_SUFFIX}`;
}

/**
 * Prepara el enlace de registro de un correo (ya normalizado y validado por quien llama). Lanza `SignupGatewayError`, con
 * solo un código, si Supabase no pudo hacer alguno de los tres pasos; en ese caso NO hay enlace que enviar.
 */
export async function prepareSignupLink(email: string): Promise<SignupLink> {
  const admin = createAdminClient().auth.admin;

  // 1. Obtener (o crear) la cuenta. Este código no se envía.
  const first = await admin.generateLink({ type: "invite", email });
  if (first.error) {
    if (first.error.code && EMAIL_EXISTS_CODES.has(first.error.code)) {
      return { status: "already_registered" };
    }
    throw new SignupGatewayError("account", first.error.code ?? first.error.status);
  }
  const account = first.data.user;
  if (!account?.id) throw new SignupGatewayError("account", "no_user");
  // Defensa: si GoTrue entregara un enlace para una cuenta ya verificada, tampoco se envía nada.
  if (account.email_confirmed_at) return { status: "already_registered" };

  // 2. Una contraseña al azar que nadie conoce (también en las cuentas nuevas).
  const updated = await admin.updateUserById(account.id, { password: randomPassword() });
  if (updated.error) {
    throw new SignupGatewayError("password", updated.error.code ?? updated.error.status);
  }

  // 3. El enlace que SÍ se envía: nace después de la contraseña, así que ningún paso anterior lo anula.
  const second = await admin.generateLink({ type: "invite", email });
  if (second.error) {
    if (second.error.code && EMAIL_EXISTS_CODES.has(second.error.code)) {
      // La persona verificó el correo entre los dos pasos: ya tiene cuenta.
      return { status: "already_registered" };
    }
    throw new SignupGatewayError("link", second.error.code ?? second.error.status);
  }
  const tokenHash = second.data.properties?.hashed_token;
  if (!tokenHash) throw new SignupGatewayError("link", "no_token");
  return { status: "ready", tokenHash };
}
