import "server-only";
import { logAuditEvent } from "@/lib/audit/log";
import { FORGOT_PASSWORD_PATH } from "@/lib/auth/paths";
import { loadEmailConfig } from "@/lib/email/config";
import { buildMfaAnnulledNotice } from "@/lib/email/mfa-annulled-notice";
import { EmailConfigError, getEmailTransport } from "@/lib/email/transport";
import { getAppOrigin } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { sendWithRetry } from "@/lib/quotes/send/dispatch";
import { lockAccountAndRemoveFactors } from "./mfa-admin-gateway";
import {
  MfaAlertsGatewayError,
  claimAnnulLink,
  completeAnnulLink,
  releaseAnnulLink,
  revokeRemainingSessions,
} from "./mfa-alerts-gateway";
import {
  MFA_ANNUL_TOKEN_LENGTH,
  hashMfaAnnulToken,
  isWellFormedMfaAnnulToken,
} from "./mfa-annul-token";
import { consumeMfaAnnulQuota } from "./login-rate-limit";

/**
 * Anular la activación del segundo paso desde el enlace del correo de aviso (H-118b). El ORDEN es el del diseño (§4):
 *  1. forma del código (43 caracteres) ANTES de tocar la base; después los límites por IP y por enlace;
 *  2. tomar el enlace en la base (`mfa_annul_claim`: lo toma 2 minutos; el mismo `invalid` si no existe, venció, ya se usó
 *     o está tomado);
 *  3. dejar la cuenta sin acceso: contraseña al azar → borrar TODOS los factores → comprobar que no quede ninguna sesión.
 *     Repetir estos pasos no hace daño;
 *  4. completar en la base (`mfa_annul_complete`): consume TODOS los enlaces abiertos de la cuenta, cierra los avisos y audita;
 *  5. mandar a la persona el correo de «¿Olvidaste tu contraseña?» (decisión D4: NO se abre una sesión de recuperación desde
 *     esta página); y
 *  6. mandar el correo «Anulamos la verificación en dos pasos de tu cuenta». Si algo falla en 5 o 6 NO se corta nada: la
 *     anulación ya está hecha.
 * Si algo falla en el paso 3 o 4: se suelta el enlace, se audita `session.mfa_annul_failed` y se responde `failed`.
 *
 * Reglas: el destinatario de TODOS los correos es el que la base lee de `auth.users` (nunca uno de la petición); el código del
 * enlace llega aquí y no sale: ni a `serverLog`, ni a la auditoría, ni a la base (solo su huella); ningún error dice si el
 * enlace existía. Nada hecho desde una sesión invalida enlaces abiertos: solo `mfa_annul_complete`.
 */

const SEND_DEADLINE_MS = 15_000;

/** De dónde viene la petición: solo para el límite por IP y para que la auditoría quede con su origen. */
export type AnnulRequest = {
  clientIp: string | null;
  requestId: string | null;
  userAgent: string | null;
};

export type AnnulOutcome =
  /** Anulada. `recoveryEmailSent`: el correo para elegir la contraseña nueva salió. */
  | { status: "annulled"; recoveryEmailSent: boolean }
  /** El enlace no existe, venció, ya se usó o está tomado (todo da lo mismo), o no tiene la forma de un código. */
  | { status: "invalid" }
  | { status: "rate_limited" }
  /** Falló un paso: el enlace quedó suelto y se puede abrir de nuevo. */
  | { status: "failed" };

/**
 * Pide el correo de recuperación de contraseña a Supabase (el mismo flujo de «¿Olvidaste tu contraseña?», que ya funciona sin
 * código porque el factor ya no existe). Lo pone quien llama (necesita las cookies de la petición para el flujo PKCE).
 * Devuelve si Supabase aceptó el pedido. Nunca debe recibir un correo de la petición: este servicio le pasa el de la cuenta.
 */
export type SendRecoveryEmail = (email: string) => Promise<boolean>;

const codeOf = (cause: unknown): string =>
  cause instanceof MfaAlertsGatewayError
    ? `gateway_${cause.code}`
    : cause instanceof Error && cause.name === "MfaAdminGatewayError"
      ? cause.message.slice(0, 60)
      : cause instanceof EmailConfigError
        ? "email_config"
        : "unexpected";

function auditHeaders(request: AnnulRequest): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (request.clientIp) headers["x-cp-client-ip"] = request.clientIp;
  if (request.requestId) headers["x-cp-request-id"] = request.requestId;
  if (request.userAgent) headers["user-agent"] = request.userAgent.slice(0, 300);
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Suelta el enlace y deja constancia del fallo. Nunca lanza. */
async function failAnnulment(linkId: string, userId: string, reason: string): Promise<void> {
  try {
    await releaseAnnulLink(linkId);
  } catch (cause) {
    await serverLog("error", "mfa_annul_release_failed", { code: codeOf(cause) });
  }
  await serverLog("error", "mfa_annul_failed", { code: reason });
  await logAuditEvent({
    action: "session.mfa_annul_failed",
    result: "failure",
    actorUserId: userId,
    details: { reason, stage: "annul" },
  });
}

async function sendAnnulledNotice(email: string, alertKey: string): Promise<void> {
  try {
    const config = loadEmailConfig();
    const built = buildMfaAnnulledNotice({
      recipientAddress: email,
      fromAddress: config.fromAddress,
      annulledAt: new Date(),
      forgotPasswordUrl: `${getAppOrigin()}${FORGOT_PASSWORD_PATH}`,
      idempotencyKey: alertKey,
    });
    if (!built.ok) {
      await serverLog("warn", "mfa_annulled_notice_failed", { code: built.code });
      return;
    }
    const result = await sendWithRetry(getEmailTransport(config), built.message, {
      deadlineMs: Date.now() + SEND_DEADLINE_MS,
    });
    if (!result.ok) await serverLog("warn", "mfa_annulled_notice_failed", { code: result.code });
  } catch (cause) {
    await serverLog("warn", "mfa_annulled_notice_failed", { code: codeOf(cause) });
  }
}

export async function annulSecondStep(
  rawToken: string,
  request: AnnulRequest,
  sendRecoveryEmail: SendRecoveryEmail,
): Promise<AnnulOutcome> {
  // 1. La forma, ANTES de tocar la base: lo que no es un código no consulta nada.
  if (
    typeof rawToken !== "string" ||
    rawToken.length !== MFA_ANNUL_TOKEN_LENGTH ||
    !isWellFormedMfaAnnulToken(rawToken)
  ) {
    return { status: "invalid" };
  }
  const tokenSha256 = hashMfaAnnulToken(rawToken);
  if (!(await consumeMfaAnnulQuota(request.clientIp, tokenSha256)))
    return { status: "rate_limited" };

  // 2. Tomar el enlace.
  let claimed: Awaited<ReturnType<typeof claimAnnulLink>>;
  try {
    claimed = await claimAnnulLink(tokenSha256);
  } catch (cause) {
    await serverLog("error", "mfa_annul_claim_failed", { code: codeOf(cause) });
    return { status: "failed" };
  }
  if (!claimed) return { status: "invalid" };

  // 3 y 4. Dejar la cuenta sin acceso y completar en la base.
  let completed: Awaited<ReturnType<typeof completeAnnulLink>>;
  try {
    await lockAccountAndRemoveFactors(claimed.userId);
    if ((await revokeRemainingSessions(claimed.userId)) !== 0) {
      throw new MfaAlertsGatewayError("revoke_sessions", "sessions_left");
    }
    completed = await completeAnnulLink(claimed.linkId, auditHeaders(request));
    if (!completed) throw new MfaAlertsGatewayError("annul_complete", "not_open");
  } catch (cause) {
    await failAnnulment(claimed.linkId, claimed.userId, codeOf(cause));
    return { status: "failed" };
  }

  // 5 y 6. Los correos: al de la cuenta (de auth.users). Si fallan, la anulación igual vale.
  let recoveryEmailSent = false;
  if (completed.email) {
    try {
      recoveryEmailSent = await sendRecoveryEmail(completed.email);
    } catch (cause) {
      await serverLog("warn", "mfa_annul_recovery_failed", { code: codeOf(cause) });
    }
    if (!recoveryEmailSent)
      await serverLog("warn", "mfa_annul_recovery_not_sent", { code: "not_sent" });
    await sendAnnulledNotice(completed.email, claimed.linkId);
  } else {
    await serverLog("warn", "mfa_annul_recovery_not_sent", { code: "no_recipient" });
  }
  return { status: "annulled", recoveryEmailSent };
}
