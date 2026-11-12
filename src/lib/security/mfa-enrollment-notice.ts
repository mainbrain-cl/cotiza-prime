import "server-only";
import { logAuditEvent } from "@/lib/audit/log";
import { MFA_FACTOR_TYPE } from "@/lib/auth/second-step";
import { loadEmailConfig } from "@/lib/email/config";
import { buildMfaEnrollmentNotice } from "@/lib/email/mfa-enrollment-notice";
import { EmailConfigError, getEmailTransport } from "@/lib/email/transport";
import { getAppOrigin } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { sendWithRetry } from "@/lib/quotes/send/dispatch";
import { deleteMfaFactor } from "./mfa-admin-gateway";
import {
  MfaAlertsGatewayError,
  reserveEnrollmentAlert,
  revertEnrollmentAlert,
  settleEnrollmentAlert,
} from "./mfa-alerts-gateway";
import { hashMfaAnnulToken, mfaAnnulUrl, newMfaAnnulToken } from "./mfa-annul-token";

/**
 * El aviso de que se activó el segundo paso (H-118a): reserva en la base los avisos pendientes de la cuenta, manda el
 * correo con el enlace para anular la activación y deja el resultado anotado. Si el proveedor no acepta el correo, la
 * activación se REVIERTE (se borra el factor): dejarla activa con una advertencia no protege, porque la lee quien activó,
 * que puede ser el atacante.
 *
 * Reglas que no se pueden olvidar:
 * - El destinatario es SIEMPRE el correo que la base leyó de `auth.users` al reservar; nunca uno de la petición.
 * - La dirección del enlace sale de `APP_ORIGIN` (`getAppOrigin()`), nunca de la petición.
 * - El código del enlace nace aquí, viaja SOLO en el correo y en la base queda su huella. Ni el código, ni su huella, ni la
 *   contraseña ni el correo van a `serverLog` ni a la auditoría (guardia 14f): solo códigos de error.
 */

/** Cuánto se espera, como máximo, para enviar un aviso (un envío de correo tiene su propio tope de 15 s). */
const SEND_DEADLINE_MS = 15_000;
/** Cuántos avisos pendientes de una cuenta se atienden en una llamada. */
const MAX_NOTICES_PER_CALL = 3;
const NOT_SENT_CODE = "not_sent";
const NO_RECIPIENT_CODE = "no_recipient";

export type NoticeFailure = { alertId: string | null; factorId: string | null; code: string };

export type NoticeDelivery = {
  /** Factores cuyo aviso salió (el proveedor aceptó el correo). */
  sentFactorIds: string[];
  /** El correo al que salió el primer aviso (para decirle a la persona «te enviamos un aviso a …»). */
  sentTo: string | null;
  failures: NoticeFailure[];
};

const codeOf = (cause: unknown): string =>
  cause instanceof MfaAlertsGatewayError
    ? `gateway_${cause.code}`
    : cause instanceof EmailConfigError
      ? "email_config"
      : "unexpected";

/**
 * Atiende los avisos `pending` de la cuenta (hasta 3 por llamada). NUNCA lanza: cada fallo queda como un código en
 * `failures`. Se llama SIEMPRE tras una activación, haya salido bien o mal la verificación (cierra la carrera de quien
 * verificó el factor directo con el permiso vivo), y tras cada ingreso con código para reintentar los que quedaron.
 */
export async function deliverPendingEnrollmentNotices(userId: string): Promise<NoticeDelivery> {
  const delivery: NoticeDelivery = { sentFactorIds: [], sentTo: null, failures: [] };
  for (let round = 0; round < MAX_NOTICES_PER_CALL; round += 1) {
    const token = newMfaAnnulToken();
    let reserved: Awaited<ReturnType<typeof reserveEnrollmentAlert>>;
    try {
      reserved = await reserveEnrollmentAlert(userId, hashMfaAnnulToken(token));
    } catch (cause) {
      const code = codeOf(cause);
      await serverLog("warn", "mfa_notice_failed", { stage: "reserve", code });
      delivery.failures.push({ alertId: null, factorId: null, code });
      return delivery;
    }
    if (!reserved.reserved) return delivery;

    let failureCode: string | null = null;
    let sent: { provider: string; providerMessageId: string } | null = null;
    try {
      if (!reserved.email || !reserved.expiresAt || !reserved.verifiedAt) {
        failureCode = NO_RECIPIENT_CODE;
      } else {
        const config = loadEmailConfig();
        const built = buildMfaEnrollmentNotice({
          recipientAddress: reserved.email,
          fromAddress: config.fromAddress,
          enrolledAt: reserved.verifiedAt,
          annulUrl: mfaAnnulUrl(getAppOrigin(), token),
          expiresAt: reserved.expiresAt,
          // Una clave por ENLACE (no por aviso): un reintento lleva un código nuevo y, con la misma clave, el proveedor lo rechazaría.
          // Es el identificador del enlace; nunca su huella ni su código.
          idempotencyKey: reserved.linkId ?? undefined,
        });
        if (!built.ok) {
          failureCode = built.code;
        } else {
          const transport = getEmailTransport(config);
          const result = await sendWithRetry(transport, built.message, {
            deadlineMs: Date.now() + SEND_DEADLINE_MS,
          });
          if (result.ok) {
            sent = { provider: transport.provider, providerMessageId: result.providerMessageId };
          } else {
            failureCode = result.code;
          }
        }
      }
    } catch (cause) {
      failureCode = codeOf(cause);
    }
    if (failureCode)
      await serverLog("warn", "mfa_notice_failed", { stage: "send", code: failureCode });

    try {
      await settleEnrollmentAlert({
        alertId: reserved.alertId,
        ...(sent ? { sent } : { errorCode: failureCode ?? "unknown" }),
      });
    } catch (cause) {
      // Si el correo salió, la persona fue avisada: no se revierte por no haber podido anotarlo.
      await serverLog("warn", "mfa_notice_settle_failed", { code: codeOf(cause) });
    }
    if (sent) {
      delivery.sentFactorIds.push(reserved.factorId);
      delivery.sentTo ??= reserved.email;
      await logAuditEvent({
        action: "session.mfa_notice_sent",
        result: "success",
        actorUserId: userId,
        details: { stage: "enrollment", factorType: MFA_FACTOR_TYPE },
      });
    } else {
      delivery.failures.push({
        alertId: reserved.alertId,
        factorId: reserved.factorId,
        code: failureCode ?? "unknown",
      });
    }
  }
  return delivery;
}

/** El código que explica por qué no salió el aviso de ESTE factor (o uno genérico si no hay registro). */
export function failureCodeFor(delivery: NoticeDelivery, factorId: string): string {
  return (
    delivery.failures.find((failure) => failure.factorId === factorId)?.code ??
    delivery.failures[0]?.code ??
    NOT_SENT_CODE
  );
}

/**
 * Revierte una activación cuyo aviso no salió: primero borra el factor (con la llave maestra, por la pasarela) y después lo
 * anota en la base (`reverted`) y en la auditoría. Si el factor no se pudo borrar, NO se anota nada (el aviso sigue
 * pendiente y se reintenta) y devuelve `false`. Nunca lanza.
 */
export async function revertEnrollment(
  userId: string,
  factorId: string,
  reason: string,
): Promise<boolean> {
  try {
    await deleteMfaFactor(userId, factorId);
  } catch (cause) {
    await serverLog("error", "mfa_revert_failed", {
      code: cause instanceof Error ? cause.message.slice(0, 60) : "unknown",
    });
    return false;
  }
  try {
    await revertEnrollmentAlert(userId, factorId, reason);
  } catch (cause) {
    await serverLog("warn", "mfa_revert_settle_failed", { code: codeOf(cause) });
  }
  await logAuditEvent({
    action: "session.mfa_enroll_reverted",
    result: "failure",
    actorUserId: userId,
    details: { reason, stage: "enrollment", factorType: MFA_FACTOR_TYPE },
  });
  return true;
}
