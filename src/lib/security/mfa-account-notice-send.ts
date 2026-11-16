import "server-only";
import { FORGOT_PASSWORD_PATH } from "@/lib/auth/paths";
import { loadEmailConfig } from "@/lib/email/config";
import {
  buildMfaRecoveryCodesCreatedNotice,
  type MfaRecoveryCodesCreatedNoticeResult,
} from "@/lib/email/mfa-recovery-codes-created-notice";
import { buildMfaRecoveryUsedNotice } from "@/lib/email/mfa-recovery-used-notice";
import { EmailConfigError, getEmailTransport } from "@/lib/email/transport";
import { getAppOrigin } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { sendWithRetry } from "@/lib/quotes/send/dispatch";

/**
 * Quien ENVÍA los avisos de seguridad de la cuenta del segundo paso (H-004b): los textos viven en `src/lib/email/` (piezas
 * puras) y aquí se les pone el remitente, la dirección de «Cambiar mi contraseña» y el plazo de envío, igual que
 * `sendAnnulledNotice` de H-118. Ningún aviso lleva códigos de respaldo.
 *
 * El destinatario lo entrega quien llama: es el correo de la cuenta tal como lo tiene Supabase Auth (el de la sesión
 * verificada o el que lee la base); jamás un correo que venga de una petición.
 */

/** Cuánto se espera, como máximo, para entregar el aviso. */
const SEND_DEADLINE_MS = 15_000;

type BuildNotice = (input: {
  recipientAddress: string;
  fromAddress: string;
  happenedAt: Date;
  forgotPasswordUrl: string;
}) => MfaRecoveryCodesCreatedNoticeResult;

/** El motivo de un fallo, sin datos de la persona (para el registro). */
const errorCodeOf = (cause: unknown): string =>
  cause instanceof EmailConfigError ? "email_config" : "unexpected";

async function sendNotice(
  build: BuildNotice,
  failureLog: string,
  recipientAddress: string,
  happenedAt: Date,
): Promise<boolean> {
  try {
    const resolved = loadEmailConfig();
    const built = build({
      recipientAddress,
      fromAddress: resolved.fromAddress,
      happenedAt,
      forgotPasswordUrl: `${getAppOrigin()}${FORGOT_PASSWORD_PATH}`,
    });
    if (!built.ok) {
      const error = built; // la guardia 14b solo deja pasar el código de un error
      await serverLog("warn", failureLog, { code: error.code });
      return false;
    }
    const result = await sendWithRetry(getEmailTransport(resolved), built.message, {
      deadlineMs: Date.now() + SEND_DEADLINE_MS,
    });
    if (!result.ok) {
      const error = result;
      await serverLog("warn", failureLog, { code: error.code });
      return false;
    }
    return true;
  } catch (cause) {
    await serverLog("warn", failureLog, { code: errorCodeOf(cause) });
    return false;
  }
}

/**
 * «Creaste códigos de respaldo nuevos» (de mejor esfuerzo: si no sale, la creación ya está hecha y solo se registra el
 * código del error). Devuelve si el aviso salió. Nunca lanza.
 */
export function sendRecoveryCodesCreatedNotice(
  recipientAddress: string,
  happenedAt: Date = new Date(),
): Promise<boolean> {
  return sendNotice(
    buildMfaRecoveryCodesCreatedNotice,
    "mfa_recovery_codes_notice_failed",
    recipientAddress,
    happenedAt,
  );
}

/**
 * «Se usó un código de respaldo en tu cuenta» (de mejor esfuerzo, decisión D5 = A de H-004b): lo que avisa ya pasó, y bloquear
 * la salida de emergencia de quien perdió el teléfono porque falla el correo la dejaría fuera. Si no sale, solo se registra el
 * código del error. Devuelve si el aviso salió. Nunca lanza.
 */
export function sendRecoveryUsedNotice(
  recipientAddress: string,
  happenedAt: Date = new Date(),
): Promise<boolean> {
  return sendNotice(
    buildMfaRecoveryUsedNotice,
    "mfa_recovery_used_notice_failed",
    recipientAddress,
    happenedAt,
  );
}
