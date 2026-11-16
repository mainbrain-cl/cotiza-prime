"use server";

import { z } from "zod";
import type { FormState } from "@/lib/auth/form-state";
import { issueRecoveryCodes, type RecoveryCodesIssued } from "@/lib/auth/recovery-code-issue";
import { normalizeRecoveryCode } from "@/lib/auth/recovery-code";
import { confirmPassword } from "@/lib/auth/reauth";
import { fieldErrorsOf, reauthPasswordSchema, totpCodeSchema } from "@/lib/auth/schemas";
import { MFA_FACTOR_TYPE } from "@/lib/auth/second-step";
import {
  CODE_FIELD,
  checkCodeBeforeVerifying,
  errorCodeOf,
  failedVerification,
  readText,
} from "@/lib/auth/second-step-checks";
import { requireUser } from "@/lib/auth/session";
import { AUTH_MESSAGES } from "@/lib/auth/errors";
import { getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { clearSecondStepFailures, releaseTotpCode } from "@/lib/security/login-rate-limit";
import { sendRecoveryCodesCreatedNotice } from "@/lib/security/mfa-account-notice-send";
import {
  MfaRecoveryGatewayError,
  acknowledgeRecoveryCodes,
} from "@/lib/security/mfa-recovery-gateway";
import { createClient } from "@/lib/supabase/server";

/**
 * Códigos de respaldo de la verificación en dos pasos, con la sesión ya completa (H-004b). Estas acciones son de la CUENTA,
 * no de una organización: no miran rol ni organización activa.
 *
 * - `regenerateRecoveryCodesAction`: crear los primeros códigos (cuentas que activaron antes de H-004b o a las que no se les
 *   pudieron crear) o generar un juego nuevo (los anteriores dejan de servir). Pide la contraseña Y el código de 6 números
 *   de la aplicación, NUNCA uno de respaldo: así ni con la sesión robada sola ni con la sesión y la contraseña, pero sin el
 *   teléfono, se pueden sacar códigos. Usa los contadores propios del camino `manage`.
 * - `acknowledgeRecoveryCodesAction`: «Guardé estos códigos en un lugar seguro».
 *
 * Los códigos solo viajan en la respuesta de la acción (un POST): nunca en una dirección, una cookie, la auditoría ni un
 * registro.
 */

const PASSWORD_FIELD = "password";

export type RegenerateRecoveryCodesState =
  FormState | ({ status: "created" } & RecoveryCodesIssued);

const RECOVERY_CODE_TYPED_IN_APP_FIELD_MESSAGE =
  "Aquí va el código de 6 números de tu aplicación, no un código de respaldo.";
const NO_FACTOR_MESSAGE =
  "No encontramos tu verificación en dos pasos activa. Recarga la página e inténtalo de nuevo.";
const BUSY_MESSAGE =
  "Estás usando un código de respaldo en este momento. Inténtalo de nuevo en unos minutos.";
const NOT_CREATED_MESSAGE =
  "No pudimos crear tus códigos de respaldo. Inténtalo de nuevo en unos minutos con el código siguiente de tu aplicación.";

/**
 * Crear (o volver a crear) los códigos de respaldo. Orden (no se puede cambiar): 1) forma de los campos, 2) la CONTRASEÑA,
 * 3) contadores y bloqueo de código ya usado, 4) el factor verificado de la persona, 5) el código de la aplicación contra
 * Supabase, 6) crear el juego, 7) auditoría (dentro de `issueRecoveryCodes`) y aviso por correo de mejor esfuerzo.
 */
export async function regenerateRecoveryCodesAction(
  _previous: RegenerateRecoveryCodesState,
  formData: FormData,
): Promise<RegenerateRecoveryCodesState> {
  const user = await requireUser();
  const { clientIp } = await getRequestContext();

  // 1) La forma de los dos campos, sin consultar nada. Un código de respaldo en el campo de la aplicación se rechaza aquí,
  // sin contar el intento.
  const rawCode = readText(formData, CODE_FIELD);
  const codeFormat = totpCodeSchema.safeParse({ code: rawCode });
  const passwordFormat = reauthPasswordSchema.safeParse({
    password: readText(formData, PASSWORD_FIELD),
  });
  if (!codeFormat.success || !passwordFormat.success) {
    const codeErrors = codeFormat.success
      ? {}
      : typeof rawCode === "string" && normalizeRecoveryCode(rawCode) !== null
        ? { code: RECOVERY_CODE_TYPED_IN_APP_FIELD_MESSAGE }
        : fieldErrorsOf(codeFormat.error);
    return {
      status: "error",
      fieldErrors: {
        ...codeErrors,
        ...(passwordFormat.success ? {} : fieldErrorsOf(passwordFormat.error)),
      },
    };
  }

  // 2) La contraseña, ANTES de los contadores del código.
  const reauth = await confirmPassword(user, passwordFormat.data.password, "regenerate");
  if (!reauth.ok) {
    return reauth.reason === "wrong_password"
      ? { status: "error", fieldErrors: { password: reauth.message } }
      : { status: "error", message: reauth.message };
  }

  // 3) Contadores PROPIOS del camino «manage» y bloqueo de código ya usado.
  const checked = await checkCodeBeforeVerifying(formData, user.id, clientIp, "manage", "manage");
  if (!checked.ok) return checked.state;

  // 4) El factor tiene que ser un TOTP VERIFICADO de esta persona, visto con los factores al día.
  const supabase = await createClient();
  const listed = await supabase.auth.mfa.listFactors();
  const factor = listed.error
    ? undefined
    : listed.data.all.find(
        (entry) => entry.factor_type === MFA_FACTOR_TYPE && entry.status === "verified",
      );
  if (!factor) {
    await releaseTotpCode(user.id, checked.code);
    if (listed.error) {
      await serverLog("error", "mfa_list_failed", { code: errorCodeOf(listed.error) });
    }
    return { status: "error", message: NO_FACTOR_MESSAGE };
  }

  // 5) El código de la aplicación, en una sola llamada (desafío y verificación juntos). Con la sesión completa funciona.
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: factor.id,
    code: checked.code,
  });
  if (error) return failedVerification(error, user.id, checked.code, clientIp, "manage", "manage");
  await clearSecondStepFailures(user.id, "manage");

  // 6) El juego nuevo reemplaza al anterior. Si falla, el código ya se gastó: se pide el siguiente.
  const issued = await issueRecoveryCodes(user.id, factor.id, "regenerate");
  if (!issued.ok) {
    return {
      status: "error",
      message: issued.reason === "busy" ? BUSY_MESSAGE : NOT_CREATED_MESSAGE,
    };
  }

  // 7) El aviso al correo de la cuenta (de mejor esfuerzo: la creación ya está hecha). Nunca lleva códigos.
  if (user.email) await sendRecoveryCodesCreatedNotice(user.email);
  return { status: "created", recoveryCodes: issued.recoveryCodes, setId: issued.setId };
}

export type AcknowledgeRecoveryCodesResult =
  { status: "ok" } | { status: "error"; message: string };

const NOT_ACKNOWLEDGED_MESSAGE =
  "No pudimos confirmar tus códigos. Si ya cerraste esta pantalla, genera códigos nuevos desde «Seguridad de tu cuenta».";

/**
 * «Listo»: la persona confirmó que guardó los códigos del juego `setId`. Solo vale para el juego vigente de SU cuenta (la
 * base lo comprueba); repetirlo no cambia nada.
 */
export async function acknowledgeRecoveryCodesAction(
  setId: string,
): Promise<AcknowledgeRecoveryCodesResult> {
  const user = await requireUser();
  if (!z.uuid().safeParse(setId).success) {
    return { status: "error", message: NOT_ACKNOWLEDGED_MESSAGE };
  }
  try {
    return (await acknowledgeRecoveryCodes(user.id, setId))
      ? { status: "ok" }
      : { status: "error", message: NOT_ACKNOWLEDGED_MESSAGE };
  } catch (error) {
    await serverLog("error", "mfa_recovery_acknowledge_failed", {
      code: error instanceof MfaRecoveryGatewayError ? error.code : "unexpected",
    });
    return { status: "error", message: AUTH_MESSAGES.unknown };
  }
}
