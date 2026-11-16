"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { logAuditEvent } from "@/lib/audit/log";
import type { FormState } from "@/lib/auth/form-state";
import { activeTenantIdsOf, logTenantLogins } from "@/lib/auth/login-audit";
import {
  ACCOUNT_SECURITY_NOTICES,
  ACCOUNT_SECURITY_PATH,
  RESET_PASSWORD_PATH,
} from "@/lib/auth/paths";
import { issueRecoveryCodes, type RecoveryCodesIssued } from "@/lib/auth/recovery-code-issue";
import { normalizeRecoveryCode, recoveryCodeHash } from "@/lib/auth/recovery-code";
import { confirmPassword } from "@/lib/auth/reauth";
import { fieldErrorsOf, reauthPasswordSchema, totpCodeSchema } from "@/lib/auth/schemas";
import { MFA_FACTOR_TYPE } from "@/lib/auth/second-step";
import {
  CODE_FIELD,
  blockedAttemptState,
  checkCodeBeforeVerifying,
  errorCodeOf,
  failedVerification,
  readText,
} from "@/lib/auth/second-step-checks";
import { hasRecoverySession, requirePendingSecondStep, requireUser } from "@/lib/auth/session";
import { AUTH_MESSAGES, RECOVERY_CODE_INVALID_MESSAGE } from "@/lib/auth/errors";
import { getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import {
  clearSecondStepFailures,
  recordSecondStepFailure,
  releaseTotpCode,
  type SecondStepContext,
} from "@/lib/security/login-rate-limit";
import {
  sendRecoveryCodesCreatedNotice,
  sendRecoveryUsedNotice,
} from "@/lib/security/mfa-account-notice-send";
import {
  MfaAdminGatewayError,
  hasVerifiedFactor,
  removeAllFactors,
} from "@/lib/security/mfa-admin-gateway";
import {
  MfaRecoveryGatewayError,
  acknowledgeRecoveryCodes,
  claimRecoveryCode,
  completeRecoveryCode,
  releaseRecoveryCode,
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
 * - `verifyRecoveryCodeAction`: entrar con un código de respaldo en la pantalla del código (sesión PARCIAL, tras la contraseña
 *   o tras el enlace del correo de recuperar la contraseña). Quita el segundo paso de la cuenta: ver su documentación.
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

const RECOVERY_CODE_FIELD = "recoveryCode";
const RECOVERY_LOOKS_LIKE_APP_CODE_MESSAGE =
  "Eso parece el código de tu aplicación. Aquí va un código de respaldo de 12 letras y números.";
const RECOVERY_EMPTY_MESSAGE = "Escribe tu código de respaldo.";
const RECOVERY_BAD_SHAPE_MESSAGE =
  "Un código de respaldo tiene 12 letras y números. Revisa cómo lo escribiste.";
const RECOVERY_UNFINISHED_MESSAGE = "No pudimos terminar. Intenta de nuevo en unos minutos.";

/** Suelta un código tomado cuando algo falló (así la persona no lo pierde). Nunca lanza: si no se puede, vence solo a los 2 minutos. */
async function releaseClaimedCode(codeId: string): Promise<void> {
  try {
    await releaseRecoveryCode(codeId);
  } catch (error) {
    await serverLog("error", "mfa_recovery_release_failed", {
      code: error instanceof MfaRecoveryGatewayError ? error.code : "unexpected",
    });
  }
}

/**
 * Después de que `removeAllFactors` lanzó: ¿puede seguir puesto algún factor? Solo un «no» comprobado (la lista de la cuenta no
 * trae ninguno verificado) permite seguir por el camino de éxito; si no se puede saber, se trata como «sigue puesto».
 */
async function factorMayRemain(userId: string): Promise<boolean> {
  try {
    return await hasVerifiedFactor(userId);
  } catch (error) {
    await serverLog("error", "mfa_recovery_factor_check_failed", {
      code: error instanceof MfaAdminGatewayError ? error.code : "unexpected",
    });
    return true;
  }
}

/**
 * Entrar con un código de respaldo (H-004b, §3.4 del diseño): la persona perdió su teléfono y tiene una sesión PARCIAL (la de la
 * contraseña o la del enlace del correo de recuperar la contraseña). Como Supabase no puede subir esa sesión a completa sin el
 * factor, ENTRAR CON UN CÓDIGO LO QUITA: la verificación en dos pasos queda desactivada, se cierran las otras sesiones y sale un
 * aviso por correo; la persona debe activarla de nuevo con su teléfono nuevo.
 *
 * Orden (no se puede cambiar): 1) sesión parcial y contadores del camino; 2) forma del código (sin tocar nada); 3) límite de
 * intentos, COMPARTIDO con el código de la aplicación dentro del mismo camino; 4) tomar el código por 2 minutos; 5) cerrar las
 * otras sesiones (antes de quitar el factor: una caída a mitad de camino no deja sesiones ajenas abiertas); 6) quitar los
 * factores (si lanza error se vuelve a preguntar si queda alguno: solo si SIGUE puesto se suelta el código; si ya no queda, se
 * sigue por el camino de éxito); 7) el aviso por correo, lo antes posible; 8) cerrar otra vez las otras sesiones; 9) completar
 * (marca el código usado y borra el resto del juego); 10) contadores, auditoría e ingreso en cada organización (de mejor
 * esfuerzo); 11) redirigir. El código escrito, su forma normalizada y su huella nunca llegan a un registro ni a la auditoría.
 */
export async function verifyRecoveryCodeAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // 1) Solo con la sesión a medias. Los contadores son los del camino por el que llegó la persona, nunca uno común.
  const user = await requirePendingSecondStep();
  const { clientIp } = await getRequestContext();
  const viaEmailLink = await hasRecoverySession();
  const counters: SecondStepContext = viaEmailLink ? "recovery" : "password";
  const stage = viaEmailLink ? "recovery" : "sign_in";

  // 2) La forma, sin consultar nada ni contar el intento. Seis números es el código de la aplicación, no uno de respaldo.
  const typed = readText(formData, RECOVERY_CODE_FIELD) ?? "";
  if (totpCodeSchema.safeParse({ code: typed }).success) {
    return {
      status: "error",
      fieldErrors: { [RECOVERY_CODE_FIELD]: RECOVERY_LOOKS_LIKE_APP_CODE_MESSAGE },
    };
  }
  const normalized = normalizeRecoveryCode(typed);
  if (normalized === null) {
    return {
      status: "error",
      fieldErrors: {
        [RECOVERY_CODE_FIELD]:
          typed.trim() === "" ? RECOVERY_EMPTY_MESSAGE : RECOVERY_BAD_SHAPE_MESSAGE,
      },
    };
  }

  // 3) El límite de intentos, el mismo del código de la aplicación en este camino (ventana de 15 minutos, tope del día y de la IP).
  const blocked = await blockedAttemptState(user.id, clientIp, stage, counters, "recovery_code");
  if (blocked) return blocked;

  // 4) Tomar el código por 2 minutos. La base no dice por qué no sirve; aquí tampoco.
  let claimed: Awaited<ReturnType<typeof claimRecoveryCode>>;
  try {
    claimed = await claimRecoveryCode(user.id, recoveryCodeHash(user.id, normalized));
  } catch (error) {
    await serverLog("error", "mfa_recovery_claim_failed", {
      code: error instanceof MfaRecoveryGatewayError ? error.code : "unexpected",
    });
    return { status: "error", message: RECOVERY_UNFINISHED_MESSAGE };
  }
  if (!claimed) {
    await recordSecondStepFailure(user.id, counters, clientIp);
    await logAuditEvent({
      action: "session.mfa_failed",
      result: "failure",
      actorUserId: user.id,
      details: { reason: "recovery_invalid", stage, factorType: "recovery_code" },
    });
    return { status: "error", message: RECOVERY_CODE_INVALID_MESSAGE };
  }

  // 5) Cerrar las otras sesiones ANTES de quitar el factor (barato; con la sesión a medias funciona): así, si el servidor se
  // cae a mitad de camino, no queda abierta ninguna sesión ajena de las que existían. Se repite después de quitarlo.
  const supabase = await createClient();
  const { error: earlyOthersError } = await supabase.auth.signOut({ scope: "others" });
  if (earlyOthersError) {
    await serverLog("error", "mfa_recovery_signout_others_failed", {
      code: errorCodeOf(earlyOthersError),
    });
  }

  // 6) Quitar los factores. Si lanza error NO se asume que no pasó nada: la respuesta pudo perderse con el factor ya borrado.
  // Solo si el factor SIGUE puesto (o no se puede saber) se suelta el código: la persona no lo pierde.
  try {
    await removeAllFactors(user.id);
  } catch (error) {
    await serverLog("error", "mfa_recovery_remove_factors_failed", {
      code: error instanceof MfaAdminGatewayError ? error.code : "unexpected",
    });
    if (await factorMayRemain(user.id)) {
      await releaseClaimedCode(claimed.codeId);
      await logAuditEvent({
        action: "session.mfa_failed",
        result: "failure",
        actorUserId: user.id,
        details: { reason: "recovery_remove_failed", stage, factorType: "recovery_code" },
      });
      return { status: "error", message: RECOVERY_UNFINISHED_MESSAGE };
    }
    await serverLog("warn", "mfa_recovery_remove_factors_applied_anyway", { stage });
  }

  // 7) El aviso, de mejor esfuerzo (D5 = A) y LO ANTES POSIBLE: apenas el factor está fuera, para que una caída a mitad de
  // camino no deje a la dueña sin enterarse. Va al correo de la sesión que verificó Supabase Auth (nunca uno del formulario).
  // Si la sesión no trae correo, se intenta más abajo con el que lee la base de `auth.users`.
  let noticeSent = user.email ? await sendRecoveryUsedNotice(user.email) : false;

  // 8) Cerrar otra vez las otras sesiones, DESPUÉS de quitar el factor (alcanza también a una abierta en este mismo momento).
  // Esta sesión ya quedó completa (sin factor la base la tiene por completa). Si no se pudieron cerrar, se anota y se sigue.
  const { error: othersError } = await supabase.auth.signOut({ scope: "others" });
  if (othersError) {
    await serverLog("error", "mfa_recovery_signout_others_failed", {
      code: errorCodeOf(othersError),
    });
  }

  // 9) Completar: marca el código usado y borra el resto del juego. Si pasaron más de 2 minutos desde que se tomó, la base no lo
  // da por usado (`null`): el factor YA se quitó y la persona ya quedó completa, así que no se rompe nada (los códigos de un
  // factor que no existe no sirven de todos modos).
  let completed: Awaited<ReturnType<typeof completeRecoveryCode>> = null;
  try {
    completed = await completeRecoveryCode(claimed.codeId);
  } catch (error) {
    await serverLog("error", "mfa_recovery_complete_failed", {
      code: error instanceof MfaRecoveryGatewayError ? error.code : "unexpected",
    });
  }
  if (!completed) await serverLog("warn", "mfa_recovery_complete_not_applied", { stage });
  if (!noticeSent && completed?.email) noticeSent = await sendRecoveryUsedNotice(completed.email);

  // 10) Con la sesión completa: limpiar los contadores de la ventana de ESTE camino, dejar constancia en la plataforma y en cada
  // organización donde la persona está activa, y anotar el ingreso de cada una (con la sesión parcial la base no entregaba
  // ninguna).
  await clearSecondStepFailures(user.id, counters);
  const used = {
    action: "session.mfa_recovery_used",
    result: "success",
    actorUserId: user.id,
  } as const;
  const details = { stage, otherSessionsClosed: !othersError, noticeSent };
  await logAuditEvent({ ...used, details });
  for (const tenantId of await activeTenantIdsOf(supabase, user.id)) {
    await logAuditEvent({ ...used, tenantId, details });
  }
  await logTenantLogins(supabase, user.id);

  // 11) A elegir la contraseña nueva si llegó por el enlace del correo; si no, a activar de nuevo con el teléfono.
  redirect(
    viaEmailLink
      ? RESET_PASSWORD_PATH
      : `${ACCOUNT_SECURITY_PATH}?aviso=${ACCOUNT_SECURITY_NOTICES.recoveryUsed}`,
  );
}
