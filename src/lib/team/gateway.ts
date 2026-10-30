import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";

/**
 * El PORTERO de las invitaciones (H-008). Es el único archivo de `src/lib/team/` que usa la llave maestra y
 * llama a UNA sola función de la base: `invitation_email_settle`, que cierra el registro del correo de una
 * invitación (enviado, con lo que informó el proveedor; o fallido, con un código sin datos personales).
 *
 * Por qué hace falta: ninguna persona con pase puede escribir en `email_messages` (es un registro de solo
 * agregar que anota lo que el proveedor de correo respondió), así que lo cierra el servidor, igual que en el
 * aviso interno de una cotización (`internal_notice_settle`).
 *
 * No toca ninguna tabla ni la API de cuentas (una guardia estática lo vigila). Invitar, reenviar y cancelar NO
 * usan la llave maestra: corren con el pase de la persona y la base revisa su permiso.
 */

export class TeamGatewayError extends Error {
  constructor(operation: string, code?: string) {
    super(`team_gateway_${operation}${code ? `:${code}` : ""}`);
    this.name = "TeamGatewayError";
  }
}

/** Cierra el correo de una invitación: enviado (con lo que informó el proveedor) o fallido (solo un código). */
export async function settleInvitationEmail(input: {
  emailId: string;
  sent?: { provider: string; providerMessageId: string };
  errorCode?: string;
}): Promise<void> {
  const { error } = await createAdminClient().rpc("invitation_email_settle", {
    p_email_id: input.emailId,
    p_provider: input.sent?.provider ?? null,
    p_provider_message_id: input.sent?.providerMessageId ?? null,
    p_error_code: input.sent ? null : (input.errorCode ?? "unknown"),
  });
  if (error) throw new TeamGatewayError("settle", error.code);
}
