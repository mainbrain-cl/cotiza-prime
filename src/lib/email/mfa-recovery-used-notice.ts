/**
 * Aviso de que se entró a la cuenta con un CÓDIGO DE RESPALDO (H-004b, §3.4 del diseño). Es de mejor esfuerzo (decisión D5 =
 * A): lo que avisa ya pasó (se quitó la verificación en dos pasos y se cerraron las otras sesiones). Ver
 * `mfa-account-notice.ts` para lo que tienen en común todos los avisos de seguridad de la cuenta. Nunca lleva códigos: ni el
 * usado, ni parte de él.
 */
import {
  buildMfaAccountNotice,
  type MfaAccountNoticeInput,
  type MfaAccountNoticeResult,
} from "./mfa-account-notice";

export const MFA_RECOVERY_USED_SUBJECT = "Se usó un código de respaldo en tu cuenta";

export type MfaRecoveryUsedNoticeInput = MfaAccountNoticeInput;
export type MfaRecoveryUsedNoticeResult = MfaAccountNoticeResult;

export function buildMfaRecoveryUsedNotice(
  input: MfaRecoveryUsedNoticeInput,
): MfaRecoveryUsedNoticeResult {
  return buildMfaAccountNotice(input, {
    subject: MFA_RECOVERY_USED_SUBJECT,
    describe: ({ when, account }) => [
      `El ${when}, hora de Chile, se entró a tu cuenta de Cotiza Prime (${account}) con un código de respaldo de la verificación en dos pasos.`,
      "Por seguridad desactivamos la verificación en dos pasos y cerramos tus sesiones en los otros dispositivos. Mientras no la actives de nuevo con tu teléfono, tu cuenta queda protegida solo con la contraseña.",
    ],
  });
}
