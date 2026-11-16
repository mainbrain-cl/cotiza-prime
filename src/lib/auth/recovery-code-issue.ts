import "server-only";
import { logAuditEvent } from "@/lib/audit/log";
import {
  formatRecoveryCode,
  generateRecoveryCodes,
  recoveryCodeHashes,
} from "@/lib/auth/recovery-code";
import { serverLog } from "@/lib/log/server-log";
import { MfaRecoveryGatewayError, replaceRecoveryCodes } from "@/lib/security/mfa-recovery-gateway";

/**
 * Crear un juego de códigos de respaldo (H-004b, §3.3 y §3.6 del diseño), para quien lo pide (al activar la verificación o al
 * generar códigos nuevos con la sesión abierta). No es una acción de servidor: la llaman las dos acciones, que antes
 * comprobaron todo lo demás (contraseña, código de la aplicación).
 *
 * Los códigos nacen aquí, viajan UNA vez en la respuesta de la acción que llama y en la base solo queda su huella. Aquí nunca
 * van a `serverLog` ni a la auditoría: lo único que se registra es la etapa y, si algo falla, el código de error.
 */

/** Dónde se crearon: al activar la verificación o al generar otros desde la pantalla de seguridad. */
export type RecoveryCodesStage = "enrollment" | "regenerate";

/** El juego recién creado, listo para mostrarlo: los códigos ya formateados («7KQM-3XHP-W2RT») y el identificador del juego. */
export type RecoveryCodesIssued = { recoveryCodes: string[]; setId: string };

export type IssueRecoveryCodesResult =
  | ({ ok: true } & RecoveryCodesIssued)
  /** `busy`: hay un ingreso con un código de respaldo en curso; `no_factor`: el factor ya no es un TOTP verificado. */
  | { ok: false; reason: "busy" | "no_factor" | "error" };

/**
 * Genera el juego, guarda sus huellas atadas al factor (reemplazando el anterior) y, si salió bien, deja la auditoría
 * `session.mfa_recovery_codes_created`. Nunca lanza: ante cualquier falla devuelve `{ ok: false }`.
 */
export async function issueRecoveryCodes(
  userId: string,
  factorId: string,
  stage: RecoveryCodesStage,
): Promise<IssueRecoveryCodesResult> {
  try {
    const normalized = generateRecoveryCodes();
    const replaced = await replaceRecoveryCodes(
      userId,
      factorId,
      recoveryCodeHashes(userId, normalized),
    );
    if (replaced.result !== "ok") {
      await serverLog("warn", "mfa_recovery_codes_not_created", { reason: replaced.result, stage });
      return { ok: false, reason: replaced.result };
    }
    await logAuditEvent({
      action: "session.mfa_recovery_codes_created",
      result: "success",
      actorUserId: userId,
      details: { stage },
    });
    return {
      ok: true,
      recoveryCodes: normalized.map(formatRecoveryCode),
      setId: replaced.setId,
    };
  } catch (error) {
    await serverLog("error", "mfa_recovery_codes_failed", {
      code: error instanceof MfaRecoveryGatewayError ? error.code : "unexpected",
      stage,
    });
    return { ok: false, reason: "error" };
  }
}
