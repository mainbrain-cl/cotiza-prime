"use server";

import { redirect } from "next/navigation";
import { logAuditEvent, type AuditAction } from "@/lib/audit/log";
import { AUTH_MESSAGES, classifyAuthError } from "@/lib/auth/errors";
import type { FormState } from "@/lib/auth/form-state";
import { activeTenantIdsOf, logTenantLogins } from "@/lib/auth/login-audit";
import { ACCOUNT_SECURITY_NOTICES, ACCOUNT_SECURITY_PATH } from "@/lib/auth/paths";
import { fieldErrorsOf, totpCodeSchema } from "@/lib/auth/schemas";
import { MFA_FACTOR_TYPE, MFA_ISSUER, afterSecondStepPath } from "@/lib/auth/second-step";
import {
  getSessionState,
  hasRecoverySession,
  requirePendingSecondStep,
  requireUser,
} from "@/lib/auth/session";
import { getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import {
  RATE_LIMITED_MESSAGE,
  clearSecondStepFailures,
  consumeTotpCode,
  isSecondStepLocked,
  recordSecondStepFailure,
} from "@/lib/security/login-rate-limit";
import { createClient } from "@/lib/supabase/server";
import { hasPendingInvitation } from "@/lib/team/invitation-cookie";

/**
 * Verificación en dos pasos (H-004a). Estas acciones son de la CUENTA, no de una organización: no miran rol ni organización
 * activa (cualquiera de los cinco roles puede activarla en su propia cuenta).
 *
 * Reglas que se repiten aquí y no se pueden olvidar:
 * - El límite propio de intentos y el bloqueo de códigos usados van ANTES de hablar con Supabase Auth: el límite de
 *   Supabase no frena los códigos incorrectos repetidos (comprobado en el paso 0), así que este es el único freno.
 * - Desafío y verificación en UNA sola petición (`challengeAndVerify`): si van separados, en el despliegue pueden salir
 *   con IPs distintas y Supabase rechaza con `mfa_ip_address_mismatch`.
 * - Nunca se guarda ni se registra el código, la clave ni el `uri`: `serverLog` solo recibe el código de error y la
 *   auditoría solo `{reason, stage, factorType}`.
 */

const CODE_FIELD = "code";
const FACTOR_FIELD = "factorId";
const SVG_DATA_URL_PREFIX = "data:image/svg+xml;utf-8,";

function readText(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

type AuthErrorLike = { code?: string | null; status?: number | null };
const errorCodeOf = (error: AuthErrorLike) => error.code ?? String(error.status ?? "");

type CodeCheck = { ok: true; code: string } | { ok: false; state: FormState };

/**
 * Lo que va ANTES de pedirle la verificación a Supabase: formato del código, bloqueo por intentos y código ya usado.
 * Devuelve el código limpio o el estado de error que se muestra.
 */
async function checkCodeBeforeVerifying(
  formData: FormData,
  userId: string,
  clientIp: string | null,
  stage: "sign_in" | "enrollment",
): Promise<CodeCheck> {
  const parsed = totpCodeSchema.safeParse({ code: readText(formData, CODE_FIELD) });
  if (!parsed.success) {
    return { ok: false, state: { status: "error", fieldErrors: fieldErrorsOf(parsed.error) } };
  }
  const { code } = parsed.data;

  if (await isSecondStepLocked(userId, clientIp)) {
    await logAuditEvent({
      action: "session.mfa_locked",
      result: "denied",
      actorUserId: userId,
      details: { reason: "blocked", stage, factorType: MFA_FACTOR_TYPE },
    });
    return { ok: false, state: { status: "error", message: RATE_LIMITED_MESSAGE } };
  }

  if (!(await consumeTotpCode(userId, code))) {
    // Presentar de nuevo un código ya usado cuenta como un fallo.
    const locked = await recordSecondStepFailure(userId, clientIp);
    await auditFailure(userId, stage, "code_reused", locked);
    return {
      ok: false,
      state: {
        status: "error",
        message: locked ? RATE_LIMITED_MESSAGE : AUTH_MESSAGES.mfa_code_reused,
      },
    };
  }
  return { ok: true, code };
}

async function auditFailure(
  userId: string,
  stage: "sign_in" | "enrollment",
  reason: string,
  locked: boolean,
): Promise<void> {
  const details = { reason, stage, factorType: MFA_FACTOR_TYPE };
  await logAuditEvent({
    action: "session.mfa_failed",
    result: "failure",
    actorUserId: userId,
    details,
  });
  if (locked) {
    await logAuditEvent({
      action: "session.mfa_locked",
      result: "denied",
      actorUserId: userId,
      details: { ...details, reason: "threshold_reached" },
    });
  }
}

/**
 * Resultado de un `challengeAndVerify` que falló, convertido en el estado que ve la persona. Solo un código incorrecto
 * suma al bloqueo; el límite de Supabase (429) y los demás errores no.
 */
async function failedVerification(
  error: AuthErrorLike,
  userId: string,
  clientIp: string | null,
  stage: "sign_in" | "enrollment",
): Promise<FormState> {
  const kind = classifyAuthError(error);
  await serverLog("warn", "mfa_verify_failed", { stage, code: errorCodeOf(error) });
  if (kind === "rate_limited") return { status: "error", message: RATE_LIMITED_MESSAGE };
  if (kind === "mfa_invalid_code") {
    const locked = await recordSecondStepFailure(userId, clientIp);
    await auditFailure(userId, stage, kind, locked);
    return { status: "error", message: locked ? RATE_LIMITED_MESSAGE : AUTH_MESSAGES[kind] };
  }
  await auditFailure(userId, stage, kind, false);
  return { status: "error", message: AUTH_MESSAGES[kind === "unknown" ? "mfa_unavailable" : kind] };
}

/**
 * Pantalla del código tras la contraseña: la persona tiene una sesión PARCIAL (pase aal1) y escribe el código de su
 * aplicación. Si sale bien, la sesión pasa a completa (aal2), se escribe el ingreso de cada organización y se va a donde
 * iba (inicio, invitación o elegir la contraseña nueva).
 */
export async function verifySecondStepAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePendingSecondStep();
  const state = await getSessionState();
  const { clientIp } = await getRequestContext();

  const checked = await checkCodeBeforeVerifying(formData, user.id, clientIp, "sign_in");
  if (!checked.ok) return checked.state;

  const factorId = state.status === "second_step_pending" ? state.factorId : null;
  if (!factorId) return { status: "error", message: AUTH_MESSAGES.mfa_unavailable };

  // Antes de verificar: después el pase ya no es el del enlace de recuperación.
  const context = {
    recovery: await hasRecoverySession(),
    invitation: await hasPendingInvitation(),
  };

  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: checked.code });
  if (error) return failedVerification(error, user.id, clientIp, "sign_in");

  await clearSecondStepFailures(user.id);
  await logAuditEvent({
    action: "session.mfa_verified",
    result: "success",
    actorUserId: user.id,
    details: { stage: "sign_in", factorType: MFA_FACTOR_TYPE },
  });
  // El ingreso de cada organización se escribe ahora, con la sesión ya completa (con la parcial la base no entrega ninguna).
  await logTenantLogins(supabase, user.id);
  redirect(afterSecondStepPath(context));
}

/** Lo que se le entrega a la pantalla para mostrar el código QR y la clave. Solo viaja en la respuesta de la acción. */
export type TotpEnrollment = {
  factorId: string;
  /** Imagen (data URL de un SVG) para el `<img>`: nunca se inserta como HTML. */
  qrCode: string;
  secret: string;
  uri: string;
};

export type StartEnrollmentResult =
  | { status: "started"; enrollment: TotpEnrollment }
  | { status: "already_active" }
  | { status: "error"; message: string };

/** El SVG que entrega Supabase, vuelto a codificar para que cualquier carácter viaje bien dentro de una imagen. */
function toSvgDataUrl(qrCode: string): string {
  const svg = qrCode.startsWith(SVG_DATA_URL_PREFIX)
    ? qrCode.slice(SVG_DATA_URL_PREFIX.length)
    : qrCode;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * «Activar la verificación en dos pasos», paso 1: prepara la clave y el código QR. Quita antes los intentos a medias
 * (factores sin verificar) de la persona: cuentan para el tope de Supabase y chocan por nombre. Si ya hay un factor
 * verificado no se llama a `enroll`.
 */
export async function startTotpEnrollmentAction(): Promise<StartEnrollmentResult> {
  await requireUser();
  const state = await getSessionState();
  if (state.status === "complete" && state.secondStep.active) return { status: "already_active" };

  const supabase = await createClient();
  const listed = await supabase.auth.mfa.listFactors();
  if (listed.error) {
    await serverLog("error", "mfa_list_failed", { code: errorCodeOf(listed.error) });
    return { status: "error", message: AUTH_MESSAGES.mfa_unavailable };
  }
  if (listed.data.all.some((factor) => factor.status === "verified")) {
    return { status: "already_active" };
  }
  for (const factor of listed.data.all) {
    if (factor.status !== "unverified") continue;
    const removed = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (removed.error) {
      await serverLog("error", "mfa_unenroll_failed", { code: errorCodeOf(removed.error) });
      return { status: "error", message: AUTH_MESSAGES.mfa_unavailable };
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: MFA_FACTOR_TYPE,
    issuer: MFA_ISSUER,
  });
  if (error || !data) {
    await serverLog("error", "mfa_enroll_failed", { code: error ? errorCodeOf(error) : "no_data" });
    return { status: "error", message: AUTH_MESSAGES.mfa_unavailable };
  }
  return {
    status: "started",
    enrollment: {
      factorId: data.id,
      qrCode: toSvgDataUrl(data.totp.qr_code),
      secret: data.totp.secret,
      uri: data.totp.uri,
    },
  };
}

/**
 * «Activar la verificación en dos pasos», paso 2: la persona escribe el primer código de su aplicación. Con el mismo
 * límite y bloqueo de códigos usados que al ingresar. Al verificarse, Supabase cierra las demás sesiones de la cuenta y
 * esta pasa a completa.
 */
export async function confirmTotpEnrollmentAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const { clientIp } = await getRequestContext();
  const factorId = readText(formData, FACTOR_FIELD) ?? "";

  const checked = await checkCodeBeforeVerifying(formData, user.id, clientIp, "enrollment");
  if (!checked.ok) return checked.state;

  // El factor tiene que ser un TOTP SIN verificar de esta persona, visto con los factores al día.
  const supabase = await createClient();
  const listed = await supabase.auth.mfa.listFactors();
  const factor = listed.error
    ? undefined
    : listed.data.all.find(
        (entry) =>
          entry.id === factorId &&
          entry.factor_type === MFA_FACTOR_TYPE &&
          entry.status === "unverified",
      );
  if (!factor) return { status: "error", message: AUTH_MESSAGES.mfa_expired };

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: checked.code });
  if (error) return failedVerification(error, user.id, clientIp, "enrollment");

  await clearSecondStepFailures(user.id);
  const enrolled: { action: AuditAction } = { action: "session.mfa_enrolled" };
  const details = { stage: "enrollment", factorType: MFA_FACTOR_TYPE };
  await logAuditEvent({ ...enrolled, result: "success", actorUserId: user.id, details });
  // En cada organización de la persona (la sesión ya es completa): sirve para H-004c y para que cada Dueño lo vea.
  for (const tenantId of await activeTenantIdsOf(supabase, user.id)) {
    await logAuditEvent({
      ...enrolled,
      result: "success",
      actorUserId: user.id,
      tenantId,
      details,
    });
  }
  redirect(`${ACCOUNT_SECURITY_PATH}?aviso=${ACCOUNT_SECURITY_NOTICES.enabled}`);
}
