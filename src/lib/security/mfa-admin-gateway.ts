import "server-only";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin-client";

/**
 * La PASARELA de la API de administración de cuentas de Supabase Auth (`auth.admin.*`) para el segundo paso (H-118). Es el
 * ÚNICO archivo de la aplicación que nombra `auth.admin` (una guardia estática lo vigila: la 14 de `static-guards.test.ts`;
 * H-116 sumará aquí su propia pasarela si la necesita). Usa la llave maestra, que se salta toda la seguridad por fila:
 * por eso cada función hace UNA cosa, con argumentos que el servidor ya validó, y nunca recibe nada del navegador.
 *
 * Hace dos cosas: (1) borrar un factor de la cuenta, para REVERTIR una activación cuando el correo de aviso no pudo salir
 * (H-118a); y (2) dejar la cuenta sin acceso para ANULAR una activación que la persona no hizo (H-118b): inutilizar la
 * contraseña con una al azar que nadie conoce, borrar TODOS sus factores y, con eso, cerrar todas sus sesiones (cambiar la
 * contraseña por esta vía cierra todas las sesiones y tokens de renovación: comprobado en `tests/db/mfa-annul.test.ts`).
 *
 * Nunca se registra el correo, el código ni la clave: el único dato que puede llegar a un registro es un código de error.
 */

export class MfaAdminGatewayError extends Error {
  readonly code: string;
  constructor(operation: string, code?: string | number | null) {
    const detail = code === null || code === undefined ? "" : `:${String(code)}`;
    super(`mfa_admin_gateway_${operation}${detail}`);
    this.name = "MfaAdminGatewayError";
    this.code = detail ? detail.slice(1) : "unknown";
  }
}

const NOT_FOUND_STATUS = 404;

/**
 * Borra UN factor de la cuenta (verificado o no). Que el factor ya no exista cuenta como hecho (repetir no hace daño). No
 * cierra sesiones. Lanza `MfaAdminGatewayError` (solo con un código) si Supabase no lo pudo borrar.
 */
export async function deleteMfaFactor(userId: string, factorId: string): Promise<void> {
  const { error } = await createAdminClient().auth.admin.mfa.deleteFactor({
    id: factorId,
    userId,
  });
  if (!error) return;
  if (error.status === NOT_FOUND_STATUS) return;
  throw new MfaAdminGatewayError("delete_factor", error.code ?? error.status);
}

/**
 * Borra TODOS los factores de la cuenta (verificados o no), SIN tocar la contraseña ni cerrar sesiones (H-004b: entrar con un
 * código de respaldo). Que un factor ya no exista cuenta como hecho, así que repetirlo no hace daño. Quitar el factor deja la
 * sesión «a medias» de la persona como completa (`app.second_step_pending()` pasa a falso: comprobado en el paso 0 de H-004b);
 * cerrar las demás sesiones es cosa de quien llama. Lanza `MfaAdminGatewayError` (solo con un código) si Supabase no pudo
 * listar o borrar alguno.
 */
export async function removeAllFactors(userId: string): Promise<void> {
  const listed = await createAdminClient().auth.admin.mfa.listFactors({ userId });
  if (listed.error) {
    throw new MfaAdminGatewayError("list_factors", listed.error.code ?? listed.error.status);
  }
  for (const factor of listed.data.factors) await deleteMfaFactor(userId, factor.id);
}

/**
 * ¿Le queda a la cuenta ALGÚN factor verificado (de cualquier tipo)? Es lo mismo que cuenta la base para dejar una sesión «a
 * medias» (`app.second_step_pending()`). Sirve para saber, cuando `removeAllFactors` lanzó, si el factor SÍ se borró aunque la
 * respuesta no llegó (H-004b, corrección C1). Lanza `MfaAdminGatewayError` (solo con un código) si no pudo listar.
 */
export async function hasVerifiedFactor(userId: string): Promise<boolean> {
  const listed = await createAdminClient().auth.admin.mfa.listFactors({ userId });
  if (listed.error) {
    throw new MfaAdminGatewayError("list_factors", listed.error.code ?? listed.error.status);
  }
  return listed.data.factors.some((factor) => factor.status === "verified");
}

/** Bytes al azar de la contraseña que inutiliza la cuenta (en base64url son 64 caracteres), más un sufijo que cumple cualquier regla de composición. */
const UNUSABLE_PASSWORD_BYTES = 48;
const UNUSABLE_PASSWORD_SUFFIX = "Aa1!";

/**
 * Deja la cuenta sin acceso: pone una contraseña al azar que nadie conoce (lo que cierra TODAS las sesiones y los tokens de
 * renovación) y borra TODOS sus factores del segundo paso. Repetirlo no hace daño (la contraseña vuelve a ser otra al azar y
 * un factor que ya no existe cuenta como hecho). La persona recupera el acceso con el correo de «¿Olvidaste tu contraseña?».
 * Lanza `MfaAdminGatewayError` (solo con un código) si algún paso falla; el llamador suelta el enlace.
 */
export async function lockAccountAndRemoveFactors(userId: string): Promise<void> {
  const admin = createAdminClient();
  const changed = await admin.auth.admin.updateUserById(userId, {
    password: `${randomBytes(UNUSABLE_PASSWORD_BYTES).toString("base64url")}${UNUSABLE_PASSWORD_SUFFIX}`,
  });
  if (changed.error) {
    throw new MfaAdminGatewayError("lock_password", changed.error.code ?? changed.error.status);
  }
  await removeAllFactors(userId);
}
