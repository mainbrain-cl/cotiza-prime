/**
 * Aviso de que se CREARON códigos de respaldo nuevos (H-004b, §3.6 del diseño): los anteriores dejan de servir. De mejor
 * esfuerzo. Ver `mfa-account-notice.ts` para lo que tienen en común todos los avisos de seguridad de la cuenta. Nunca lleva
 * códigos: los códigos solo se muestran una vez, en la pantalla, a quien los pidió.
 */
import {
  buildMfaAccountNotice,
  type MfaAccountNoticeInput,
  type MfaAccountNoticeResult,
} from "./mfa-account-notice";

export const MFA_RECOVERY_CODES_CREATED_SUBJECT =
  "Se crearon códigos de respaldo nuevos en tu cuenta";

export type MfaRecoveryCodesCreatedNoticeInput = MfaAccountNoticeInput;
export type MfaRecoveryCodesCreatedNoticeResult = MfaAccountNoticeResult;

export function buildMfaRecoveryCodesCreatedNotice(
  input: MfaRecoveryCodesCreatedNoticeInput,
): MfaRecoveryCodesCreatedNoticeResult {
  return buildMfaAccountNotice(input, {
    subject: MFA_RECOVERY_CODES_CREATED_SUBJECT,
    describe: ({ when, account }) => [
      `El ${when}, hora de Chile, se crearon códigos de respaldo nuevos de la verificación en dos pasos de tu cuenta de Cotiza Prime (${account}).`,
      "Si había otros códigos de respaldo, ya no sirven. Por seguridad, este correo no lleva ningún código: los viste una sola vez en la pantalla.",
    ],
  });
}
