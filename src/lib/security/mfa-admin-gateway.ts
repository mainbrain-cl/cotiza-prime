import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";

/**
 * La PASARELA de la API de administración de cuentas de Supabase Auth (`auth.admin.*`) para el segundo paso (H-118). Es el
 * ÚNICO archivo de la aplicación que nombra `auth.admin` (una guardia estática lo vigila: la 14 de `static-guards.test.ts`;
 * H-116 sumará aquí su propia pasarela si la necesita). Usa la llave maestra, que se salta toda la seguridad por fila:
 * por eso cada función hace UNA cosa, con argumentos que el servidor ya validó, y nunca recibe nada del navegador.
 *
 * Hoy solo hace una cosa: borrar un factor de la cuenta. Sirve para REVERTIR una activación cuando el correo de aviso no
 * pudo salir (la persona no puede dejar activo un segundo paso del que nadie fue avisado).
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
