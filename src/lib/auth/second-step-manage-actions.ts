"use server";

import { redirect } from "next/navigation";
import { logAuditEvent } from "@/lib/audit/log";
import {
  AUTH_MESSAGES,
  MFA_DISABLE_NOTICE_FAILED_MESSAGE,
  RECOVERY_CODE_INVALID_MESSAGE,
} from "@/lib/auth/errors";
import type { FormState } from "@/lib/auth/form-state";
import { activeTenantIdsOf } from "@/lib/auth/login-audit";
import { ACCOUNT_SECURITY_NOTICES, ACCOUNT_SECURITY_PATH } from "@/lib/auth/paths";
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
import { getSessionState, requireUser } from "@/lib/auth/session";
import { getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { clearSecondStepFailures, recordSecondStepFailure } from "@/lib/security/login-rate-limit";
import { sendDisabledNotice } from "@/lib/security/mfa-account-notice-send";
import {
  MfaRecoveryGatewayError,
  claimRecoveryCode,
  completeRecoveryCode,
  releaseRecoveryCode,
  revokeRecoveryCodes,
} from "@/lib/security/mfa-recovery-gateway";
import { createClient } from "@/lib/supabase/server";

/**
 * Desactivar la verificación en dos pasos con la sesión ya completa (H-004b, etapa C, §3.5 del diseño). Es de la CUENTA, no de
 * una organización: no mira rol ni organización activa.
 *
 * Pide la contraseña Y un código: el de 6 números de la aplicación, o uno de respaldo (12 letras y números) si la persona perdió
 * el teléfono pero conserva la sesión abierta. Los dos van en UN solo campo y se distinguen por su forma.
 *
 * Orden (no se puede cambiar; lo vigila la guardia 14m): 1) sesión completa con la verificación activa; 2) forma de los campos;
 * 3) la CONTRASEÑA; 4) el código, con los contadores propios del camino «manage» (los de respaldo se TOMAN por 2 minutos); 5) el
 * correo de aviso, OBLIGATORIO (D4 = A): si no sale no se cambia nada y se suelta el código de respaldo; 6) quitar el factor
 * con la PROPIA sesión de la persona (nunca con la llave maestra: así Supabase vuelve a exigir el segundo paso; si falla se
 * vuelve a leer la lista y solo si el factor SIGUE puesto se suelta el código); 7) borrar los
 * códigos de respaldo; 8) cerrar las otras sesiones; 9) auditoría; 10) redirigir.
 *
 * No toca los enlaces de anulación de H-118 (nada hecho desde una sesión los invalida). Si algo falla antes de quitar el factor,
 * un código de respaldo tomado se SUELTA: la persona no lo pierde. Un doble envío no rompe: quitar un factor que ya no existe
 * se da por hecho. Ni la contraseña ni el código, su forma normalizada o su huella llegan a un registro o a la auditoría.
 */

const PASSWORD_FIELD = "password";
const NO_CODE_MESSAGE =
  "Escribe el código de 6 números de tu aplicación o un código de respaldo de 12 letras y números.";
const BAD_SHAPE_MESSAGE =
  "El código de tu aplicación tiene 6 números y el de respaldo 12 letras y números. Revisa cómo lo escribiste.";
const UNFINISHED_MESSAGE =
  "No pudimos desactivar la verificación. Inténtalo de nuevo en unos minutos.";
/** Supabase responde 404 / `mfa_factor_not_found` si el factor ya no existe. */
const HTTP_NOT_FOUND = 404;

/** Suelta un código tomado cuando algo falló. Nunca lanza: si no se puede, vence solo a los 2 minutos. */
async function releaseClaimedCode(codeId: string | null): Promise<void> {
  if (!codeId) return;
  try {
    await releaseRecoveryCode(codeId);
  } catch (error) {
    await serverLog("error", "mfa_recovery_release_failed", {
      code: error instanceof MfaRecoveryGatewayError ? error.code : "unexpected",
    });
  }
}

/**
 * Después de que `unenroll` falló: ¿puede seguir puesto el factor TOTP verificado? Solo un «no» comprobado (la lista de la
 * propia sesión ya no lo trae) permite seguir por el camino de éxito; si no se puede leer, se trata como «sigue puesto».
 */
async function factorMayRemain(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<boolean> {
  const listed = await supabase.auth.mfa.listFactors();
  if (listed.error) {
    await serverLog("error", "mfa_list_failed", { code: errorCodeOf(listed.error) });
    return true;
  }
  return listed.data.all.some(
    (entry) => entry.factor_type === MFA_FACTOR_TYPE && entry.status === "verified",
  );
}

export async function disableSecondStepAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // 1) Una sesión COMPLETA con la verificación activa. Si ya no está activa (un doble envío), no hay nada que quitar.
  const user = await requireUser();
  const sessionState = await getSessionState();
  if (sessionState.status !== "complete" || !sessionState.secondStep.active) {
    redirect(ACCOUNT_SECURITY_PATH);
  }
  const { clientIp } = await getRequestContext();

  // 2) La forma de los dos campos, sin consultar nada ni contar el intento. Seis números = código de la aplicación; 12 símbolos
  // = código de respaldo; cualquier otra cosa no es un código.
  const typed = readText(formData, CODE_FIELD) ?? "";
  const passwordFormat = reauthPasswordSchema.safeParse({
    password: readText(formData, PASSWORD_FIELD),
  });
  const isAppCode = totpCodeSchema.safeParse({ code: typed }).success;
  const recoveryNormalized = isAppCode ? null : normalizeRecoveryCode(typed);
  const usingRecovery = recoveryNormalized !== null;
  if (!passwordFormat.success || (!isAppCode && !usingRecovery)) {
    return {
      status: "error",
      fieldErrors: {
        ...(passwordFormat.success ? {} : fieldErrorsOf(passwordFormat.error)),
        ...(isAppCode || usingRecovery
          ? {}
          : { [CODE_FIELD]: typed.trim() === "" ? NO_CODE_MESSAGE : BAD_SHAPE_MESSAGE }),
      },
    };
  }

  // 3) La contraseña, ANTES de los contadores y del código: quien tiene la sesión pero no la contraseña no gasta los intentos
  // de la dueña ni toma un código de respaldo.
  const reauth = await confirmPassword(user, passwordFormat.data.password, "disable");
  if (!reauth.ok) {
    return reauth.reason === "wrong_password"
      ? { status: "error", fieldErrors: { password: reauth.message } }
      : { status: "error", message: reauth.message };
  }

  // El factor TOTP verificado, visto con los factores al día. Si ya no hay (otra pestaña lo quitó), está hecho.
  const supabase = await createClient();
  const listed = await supabase.auth.mfa.listFactors();
  if (listed.error) {
    await serverLog("error", "mfa_list_failed", { code: errorCodeOf(listed.error) });
    return { status: "error", message: AUTH_MESSAGES.mfa_unavailable };
  }
  const factor = listed.data.all.find(
    (entry) => entry.factor_type === MFA_FACTOR_TYPE && entry.status === "verified",
  );
  if (!factor) redirect(ACCOUNT_SECURITY_PATH);

  // 4) El código, con los contadores propios del camino «manage». Los dos tipos comparten la misma ventana, tope del día y tope
  // de la IP: cambiar de uno a otro no da intentos nuevos.
  let claimedCodeId: string | null = null;
  if (recoveryNormalized !== null) {
    const blocked = await blockedAttemptState(
      user.id,
      clientIp,
      "manage",
      "manage",
      "recovery_code",
    );
    if (blocked) return blocked;
    let claimed: Awaited<ReturnType<typeof claimRecoveryCode>>;
    try {
      claimed = await claimRecoveryCode(user.id, recoveryCodeHash(user.id, recoveryNormalized));
    } catch (error) {
      await serverLog("error", "mfa_recovery_claim_failed", {
        code: error instanceof MfaRecoveryGatewayError ? error.code : "unexpected",
      });
      return { status: "error", message: UNFINISHED_MESSAGE };
    }
    if (!claimed) {
      await recordSecondStepFailure(user.id, "manage", clientIp);
      await logAuditEvent({
        action: "session.mfa_failed",
        result: "failure",
        actorUserId: user.id,
        details: { reason: "recovery_invalid", stage: "manage", factorType: "recovery_code" },
      });
      return { status: "error", message: RECOVERY_CODE_INVALID_MESSAGE };
    }
    // El código tiene que respaldar el MISMO factor que se va a quitar. Si no coincide, se suelta y se corta: no es de este factor.
    if (claimed.factorId !== factor.id) {
      await serverLog("warn", "mfa_recovery_factor_mismatch", { stage: "manage" });
      await releaseClaimedCode(claimed.codeId);
      return { status: "error", message: UNFINISHED_MESSAGE };
    }
    claimedCodeId = claimed.codeId;
  } else {
    const checked = await checkCodeBeforeVerifying(formData, user.id, clientIp, "manage", "manage");
    if (!checked.ok) return checked.state;
    // Con la sesión completa el código se verifica en una sola llamada (desafío y verificación juntos).
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code: checked.code,
    });
    if (error) {
      return failedVerification(error, user.id, checked.code, clientIp, "manage", "manage");
    }
  }
  await clearSecondStepFailures(user.id, "manage");

  // 5) El aviso por correo es OBLIGATORIO (D4 = A) y va ANTES de quitar nada. El destinatario es el correo de la sesión que
  // verificó Supabase Auth, nunca uno del formulario. Si no sale, no se cambia nada y el código de respaldo se suelta.
  const noticeSent = user.email ? await sendDisabledNotice(user.email) : false;
  if (!noticeSent) {
    await releaseClaimedCode(claimedCodeId);
    await logAuditEvent({
      action: "session.mfa_failed",
      result: "failure",
      actorUserId: user.id,
      details: { reason: "disable_notice_failed", stage: "manage", factorType: MFA_FACTOR_TYPE },
    });
    return { status: "error", message: MFA_DISABLE_NOTICE_FAILED_MESSAGE };
  }

  // 6) Quitar el factor con la PROPIA sesión (aal2): sin llave maestra, así Supabase sigue exigiendo el segundo paso. Si el
  // factor ya no existe (doble envío), se da por hecho. Si lanza otro error NO se asume que no pasó nada (la respuesta pudo
  // perderse con el factor ya borrado): se vuelve a leer la lista y solo si el factor SIGUE puesto (o no se puede saber) se
  // suelta el código y se corta.
  const removed = await supabase.auth.mfa.unenroll({ factorId: factor.id });
  if (
    removed.error &&
    removed.error.code !== "mfa_factor_not_found" &&
    removed.error.status !== HTTP_NOT_FOUND
  ) {
    await serverLog("error", "mfa_unenroll_failed", { code: errorCodeOf(removed.error) });
    if (await factorMayRemain(supabase)) {
      await releaseClaimedCode(claimedCodeId);
      return { status: "error", message: UNFINISHED_MESSAGE };
    }
    await serverLog("warn", "mfa_unenroll_applied_anyway", { stage: "manage" });
  }

  // 7) Los códigos de respaldo ya no sirven (sin factor no hay a qué respaldar): se marca el usado y se borra el juego. Si el
  // plazo de 2 minutos de un código de respaldo pasó, `complete` no lo da por usado (`null`): no rompe nada. Si falla, el
  // factor ya no existe y los códigos quedan inútiles (la limpieza de la base los borra después): se anota y se sigue.
  if (claimedCodeId) {
    try {
      await completeRecoveryCode(claimedCodeId);
    } catch (error) {
      await serverLog("error", "mfa_recovery_complete_failed", {
        code: error instanceof MfaRecoveryGatewayError ? error.code : "unexpected",
      });
    }
  }
  try {
    await revokeRecoveryCodes(user.id);
  } catch (error) {
    await serverLog("error", "mfa_recovery_revoke_failed", {
      code: error instanceof MfaRecoveryGatewayError ? error.code : "unexpected",
    });
  }

  // 8) Cerrar las otras sesiones, DESPUÉS de quitar el factor: sin él la base las tiene por completas, así que quien tuviera una
  // abierta a medias entraría. Si no se pudieron cerrar, se anota y se sigue (la auditoría lo dice).
  const { error: othersError } = await supabase.auth.signOut({ scope: "others" });
  if (othersError) {
    await serverLog("error", "mfa_disable_signout_others_failed", {
      code: errorCodeOf(othersError),
    });
  }

  // 9) La constancia: en la plataforma y en cada organización donde la persona está ACTIVA (nunca en una que dejó).
  const disabled = {
    action: "session.mfa_disabled",
    result: "success",
    actorUserId: user.id,
  } as const;
  const details = {
    via: usingRecovery ? "recovery_code" : "totp",
    otherSessionsClosed: !othersError,
  };
  await logAuditEvent({ ...disabled, details });
  for (const tenantId of await activeTenantIdsOf(supabase, user.id)) {
    await logAuditEvent({ ...disabled, tenantId, details });
  }

  // 10) A la pantalla de seguridad, que ya muestra la verificación desactivada y el aviso.
  redirect(`${ACCOUNT_SECURITY_PATH}?aviso=${ACCOUNT_SECURITY_NOTICES.disabled}`);
}
