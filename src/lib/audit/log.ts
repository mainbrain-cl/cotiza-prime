import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";
import { getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";

/** Eventos de la aplicación que se registran en la auditoría (los cambios de datos los registra la base). */
export type AuditAction =
  | "session.login"
  | "session.logout"
  | "session.login_failed"
  | "session.login_locked"
  | "session.password_reset_requested"
  | "session.password_changed"
  | "session.mfa_enrolled"
  | "session.mfa_enroll_reverted"
  | "session.mfa_notice_sent"
  | "session.mfa_verified"
  | "session.mfa_failed"
  | "session.mfa_locked"
  | "tenant.access_denied";

export type AuditResult = "success" | "failure" | "denied";

export type AuditEvent = {
  action: AuditAction;
  result: AuditResult;
  /** Quién lo hizo, si ya se sabe. */
  actorUserId?: string | null;
  /** Los eventos sin organización van a la organización "plataforma". */
  tenantId?: string;
  resourceType?: string;
  resourceId?: string;
  /** Nunca datos personales (correo, nombre, RUT, contraseña) ni, en la verificación en dos pasos, el código, la clave ni el `uri`. */
  details?: Record<string, string | number | boolean | null>;
};

/**
 * Registra un evento de la aplicación. Es uno de los pocos usos permitidos de la llave maestra.
 *
 * Una falla al registrar no debe impedir iniciar sesión ni ver una pantalla: se deja constancia en
 * el log del servidor (sin datos personales) y se sigue.
 */
export async function logAuditEvent(event: AuditEvent): Promise<void> {
  try {
    const context = await getRequestContext();
    const admin = createAdminClient();
    const { error } = await admin.from("audit_log").insert({
      tenant_id: event.tenantId ?? PLATFORM_TENANT_ID,
      actor_type: event.actorUserId ? "user" : "public",
      actor_user_id: event.actorUserId ?? null,
      action: event.action,
      resource_type: event.resourceType ?? null,
      resource_id: event.resourceId ?? null,
      result: event.result,
      origin_ip: context.clientIp,
      user_agent: context.userAgent,
      correlation_id: context.requestId,
      details: event.details ?? {},
    });
    if (error) {
      await serverLog("error", "audit_insert_failed", { code: error.code });
    }
  } catch {
    await serverLog("error", "audit_insert_failed");
  }
}
