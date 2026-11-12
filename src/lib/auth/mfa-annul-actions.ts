"use server";

import type { FormState } from "@/lib/auth/form-state";
import { AUTH_RECOVERY_PATH } from "@/lib/auth/paths";
import { getAppOrigin, getRequestContext } from "@/lib/http/request-context";
import {
  MFA_ANNUL_DONE_MESSAGE,
  MFA_ANNUL_DONE_NO_EMAIL_MESSAGE,
  MFA_ANNUL_FAILED_MESSAGE,
  MFA_ANNUL_INVALID_MESSAGE,
} from "@/lib/auth/mfa-annul-messages";
import { serverLog } from "@/lib/log/server-log";
import { RATE_LIMITED_MESSAGE } from "@/lib/security/login-rate-limit";
import { annulSecondStep } from "@/lib/security/mfa-annul";
import { createClient } from "@/lib/supabase/server";

/**
 * Anular la activación del segundo paso desde el enlace del correo de aviso (H-118b). Es una acción SIN SESIÓN: la usa quien
 * abre el correo, que justamente puede no tener ya una (la activación cerró sus sesiones). El código del enlace llega en un
 * campo oculto (la página lo copia de la parte «#» de la dirección, que el navegador no manda al servidor) y NO sale de aquí:
 * ni a un registro, ni a la auditoría, ni a la respuesta. Todo el trabajo y el orden de los pasos viven en
 * `src/lib/security/mfa-annul.ts`; esta acción solo lo llama y traduce el resultado a un mensaje.
 *
 * Un solo mensaje cuando el enlace no existe, venció, ya se usó o está tomado: no se revela cuál ni a qué correo pertenece.
 */

const TOKEN_FIELD = "token";

export async function annulSecondStepAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = formData.get(TOKEN_FIELD);
  const token = typeof raw === "string" ? raw : "";
  const { clientIp, requestId, userAgent } = await getRequestContext();

  const outcome = await annulSecondStep(
    token,
    { clientIp, requestId, userAgent },
    // El mismo flujo de «¿Olvidaste tu contraseña?»: el servicio le pasa SIEMPRE el correo de la cuenta (de auth.users).
    async (accountEmail) => {
      const supabase = await createClient();
      const { error } = await supabase.auth.resetPasswordForEmail(accountEmail, {
        redirectTo: `${getAppOrigin()}${AUTH_RECOVERY_PATH}`,
      });
      if (error) {
        await serverLog("warn", "mfa_annul_recovery_request_failed", {
          code: error.code ?? String(error.status ?? ""),
        });
      }
      return !error;
    },
  );

  switch (outcome.status) {
    case "annulled":
      return {
        status: "saved",
        message: outcome.recoveryEmailSent
          ? MFA_ANNUL_DONE_MESSAGE
          : MFA_ANNUL_DONE_NO_EMAIL_MESSAGE,
      };
    case "rate_limited":
      return { status: "error", message: RATE_LIMITED_MESSAGE };
    case "failed":
      return { status: "error", message: MFA_ANNUL_FAILED_MESSAGE };
    case "invalid":
      return { status: "error", message: MFA_ANNUL_INVALID_MESSAGE };
  }
}
