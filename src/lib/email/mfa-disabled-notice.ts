/**
 * Aviso de que se PIDIÓ desactivar la verificación en dos pasos de la cuenta (H-004b, §3.5 del diseño). Sale ANTES de
 * desactivar (si no sale, no se desactiva: decisión D4 = A), así que va en presente y no afirma que ya quedó desactivada.
 * Ver `mfa-account-notice.ts` para lo que tienen en común todos los avisos de seguridad de la cuenta. Nunca lleva códigos.
 */
import {
  buildMfaAccountNotice,
  type MfaAccountNoticeInput,
  type MfaAccountNoticeResult,
} from "./mfa-account-notice";

export const MFA_DISABLED_SUBJECT = "Se pidió desactivar la verificación en dos pasos de tu cuenta";

export type MfaDisabledNoticeInput = MfaAccountNoticeInput;
export type MfaDisabledNoticeResult = MfaAccountNoticeResult;

export function buildMfaDisabledNotice(input: MfaDisabledNoticeInput): MfaDisabledNoticeResult {
  return buildMfaAccountNotice(input, {
    subject: MFA_DISABLED_SUBJECT,
    describe: ({ when, account }) => [
      `El ${when}, hora de Chile, se pidió desactivar la verificación en dos pasos de tu cuenta de Cotiza Prime (${account}), con tu contraseña y un código.`,
      "Desactivarla deja tu cuenta protegida solo con la contraseña y cierra tu sesión en tus otros dispositivos. Para protegerla de nuevo, vuelve a activarla desde «Seguridad de tu cuenta».",
    ],
  });
}
