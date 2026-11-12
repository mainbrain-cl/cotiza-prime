import "server-only";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin-client";

/**
 * El PORTERO de los avisos de activación del segundo paso (H-118a): cuatro funciones de la base, todas solo del servidor
 * (migración 20261113100000), llamadas con la llave maestra. No usa la API de cuentas (`auth.admin`): eso vive solo en
 * `mfa-admin-gateway.ts`. Ninguna función devuelve ni recibe el código ni la clave del segundo paso. El correo de la cuenta
 * lo entrega la base leído de `auth.users` al reservar: nunca viene de una petición.
 */

export class MfaAlertsGatewayError extends Error {
  readonly code: string;
  constructor(operation: string, code?: string | null) {
    super(`mfa_alerts_gateway_${operation}${code ? `:${code}` : ""}`);
    this.name = "MfaAlertsGatewayError";
    this.code = code ?? "unknown";
  }
}

/**
 * El «permiso»: deja anotado, por 2 minutos, que NUESTRO servidor está por verificar este factor. Sin él la base rechaza
 * pasar el factor a verificado. Devuelve `false` si el factor no es un TOTP sin verificar de esa cuenta.
 */
export async function grantEnrollmentPermit(userId: string, factorId: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("mfa_alert_expect", {
    p_user_id: userId,
    p_factor_id: factorId,
  });
  if (error) throw new MfaAlertsGatewayError("expect", error.code);
  return data === true;
}

const reservedSchema = z.discriminatedUnion("reserved", [
  z.object({ reserved: z.literal(false) }),
  z.object({
    reserved: z.literal(true),
    alert_id: z.uuid(),
    factor_id: z.uuid(),
    verified_at: z.string().nullable(),
    email: z.string().min(3).max(254).nullable(),
    expires_at: z.string().nullable(),
  }),
]);

export type ReservedAlert =
  | { reserved: false }
  | {
      reserved: true;
      alertId: string;
      factorId: string;
      verifiedAt: string | null;
      /** El correo de la cuenta (de `auth.users`), o `null` si la cuenta no tiene. */
      email: string | null;
      /** Cuándo vence el enlace de anulación que acaba de crear la base (72 horas). */
      expiresAt: string | null;
    };

/**
 * Reserva UN aviso pendiente de la cuenta y crea su enlace de anulación con la huella del código que se va a mandar.
 * Gasta un intento en la base (tope de 5, no más de uno cada 20 segundos).
 */
export async function reserveEnrollmentAlert(
  userId: string,
  tokenSha256: string,
): Promise<ReservedAlert> {
  const { data, error } = await createAdminClient().rpc("mfa_alerts_reserve", {
    p_user_id: userId,
    p_token_sha256: tokenSha256,
  });
  if (error) throw new MfaAlertsGatewayError("reserve", error.code);
  const parsed = reservedSchema.safeParse(data);
  if (!parsed.success) throw new MfaAlertsGatewayError("reserve", "shape");
  if (!parsed.data.reserved) return { reserved: false };
  return {
    reserved: true,
    alertId: parsed.data.alert_id,
    factorId: parsed.data.factor_id,
    verifiedAt: parsed.data.verified_at,
    email: parsed.data.email,
    expiresAt: parsed.data.expires_at,
  };
}

/** Cierra un intento de envío: el proveedor aceptó el correo (con su id) o falló (solo un código). */
export async function settleEnrollmentAlert(input: {
  alertId: string;
  sent?: { provider: string; providerMessageId: string };
  errorCode?: string;
}): Promise<"sent" | "failed" | "unchanged"> {
  const { data, error } = await createAdminClient().rpc("mfa_alert_settle", {
    p_alert_id: input.alertId,
    p_provider: input.sent?.provider ?? null,
    p_provider_message_id: input.sent?.providerMessageId ?? null,
    p_error_code: input.sent ? null : (input.errorCode ?? "unknown"),
  });
  if (error) throw new MfaAlertsGatewayError("settle", error.code);
  if (data === "sent" || data === "failed" || data === "unchanged") return data;
  throw new MfaAlertsGatewayError("settle", "shape");
}

/**
 * Revierte: un permiso vivo se cierra (`closed`); un aviso pendiente queda `reverted` y sus enlaces se borran (`reverted`:
 * el llamador debe borrar entonces el factor); uno ya enviado no se toca (`none`).
 */
export async function revertEnrollmentAlert(
  userId: string,
  factorId: string,
  errorCode: string,
): Promise<"closed" | "reverted" | "none"> {
  const { data, error } = await createAdminClient().rpc("mfa_alert_revert", {
    p_user_id: userId,
    p_factor_id: factorId,
    p_error_code: errorCode,
  });
  if (error) throw new MfaAlertsGatewayError("revert", error.code);
  if (data === "closed" || data === "reverted" || data === "none") return data;
  throw new MfaAlertsGatewayError("revert", "shape");
}
