"use server";

import { redirect } from "next/navigation";
import { logAuditEvent, type AuditAction } from "@/lib/audit/log";
import {
  AUTH_MESSAGES,
  MFA_LOCKED_DAY_ENROLLMENT_MESSAGE,
  MFA_LOCKED_DAY_MESSAGE,
  MFA_LOCKED_DAY_PASSWORD_MESSAGE,
  MFA_NOTICE_REVERTED_MESSAGE,
  MFA_NOTICE_REVERT_FAILED_MESSAGE,
  MFA_SIGN_IN_FAILED_MESSAGE,
  classifyAuthError,
} from "@/lib/auth/errors";
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
  beginSecondStepAttempt,
  clearSecondStepFailures,
  consumeTotpCode,
  isSecondStepIpLocked,
  recordSecondStepFailure,
  releaseTotpCode,
  type SecondStepContext,
} from "@/lib/security/login-rate-limit";
import {
  MfaAlertsGatewayError,
  grantEnrollmentPermit,
  revertEnrollmentAlert,
} from "@/lib/security/mfa-alerts-gateway";
import {
  deliverPendingEnrollmentNotices,
  failureCodeFor,
  revertEnrollment,
  type NoticeDelivery,
} from "@/lib/security/mfa-enrollment-notice";
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

/** Etapa de la verificación, para la auditoría y para el mensaje de «caducó». */
type Stage = "sign_in" | "enrollment";

/**
 * Lo que va ANTES de pedirle la verificación a Supabase: formato del código, bloqueo (de la IP, del día y de la ventana de
 * 15 minutos) y código ya usado. Los intentos de la ventana se REGISTRAN aquí, antes de verificar, para que los envíos en
 * paralelo no pasen del tope. Devuelve el código limpio o el estado de error que se muestra.
 */
async function checkCodeBeforeVerifying(
  formData: FormData,
  userId: string,
  clientIp: string | null,
  stage: Stage,
  context: SecondStepContext,
): Promise<CodeCheck> {
  const parsed = totpCodeSchema.safeParse({ code: readText(formData, CODE_FIELD) });
  if (!parsed.success) {
    return { ok: false, state: { status: "error", fieldErrors: fieldErrorsOf(parsed.error) } };
  }
  const { code } = parsed.data;

  const blocked = (await isSecondStepIpLocked(clientIp))
    ? "short"
    : await beginSecondStepAttempt(userId, context);
  if (blocked !== "none") {
    await logAuditEvent({
      action: "session.mfa_locked",
      result: "denied",
      actorUserId: userId,
      details: { reason: "blocked", stage, factorType: MFA_FACTOR_TYPE },
    });
    return {
      ok: false,
      state: {
        status: "error",
        message: blocked === "day" ? lockedDayMessageFor(context) : RATE_LIMITED_MESSAGE,
      },
    };
  }

  if (!(await consumeTotpCode(userId, code))) {
    // Un código ya usado NO es un código incorrecto (menor 5 de la revisión de Aarón al PR #44): quien lo escribe en dos
    // dispositivos dentro de 2 minutos no suma al tope del día ni al de la IP. El intento sí contó en la ventana de 15
    // minutos al registrarse arriba, y por eso repetirlo igual tiene freno.
    await auditFailure(userId, stage, "code_reused");
    return { ok: false, state: { status: "error", message: AUTH_MESSAGES.mfa_code_reused } };
  }
  return { ok: true, code };
}

/**
 * El bloqueo de 24 h con la contraseña orienta a recuperarla; el del enlace del correo no tiene esa salida; el de la
 * activación orienta a revisar la hora del teléfono.
 */
function lockedDayMessageFor(context: SecondStepContext): string {
  if (context === "enrollment") return MFA_LOCKED_DAY_ENROLLMENT_MESSAGE;
  return context === "password" ? MFA_LOCKED_DAY_PASSWORD_MESSAGE : MFA_LOCKED_DAY_MESSAGE;
}

async function auditFailure(userId: string, stage: Stage, reason: string): Promise<void> {
  await logAuditEvent({
    action: "session.mfa_failed",
    result: "failure",
    actorUserId: userId,
    details: { reason, stage, factorType: MFA_FACTOR_TYPE },
  });
}

/**
 * Resultado de un `challengeAndVerify` que falló, convertido en el estado que ve la persona. Solo un código incorrecto
 * suma al tope del día y al de la IP. Si Supabase falló por otra cosa (la red, la IP no coincidió, la sesión cambió) o
 * respondió 429, el código NO se juzgó: se libera para poder reintentar con el mismo código correcto. El 429 no suma al tope
 * del día ni al de la IP: no prueba nada contra la persona (puede ser el límite compartido de Supabase por una IP ajena), y
 * el intento ya contó en la ventana de 15 minutos al registrarse antes de llamar a Supabase.
 */
async function failedVerification(
  error: AuthErrorLike,
  userId: string,
  code: string,
  clientIp: string | null,
  stage: Stage,
  context: SecondStepContext,
): Promise<FormState> {
  const kind = classifyAuthError(error);
  await serverLog("warn", "mfa_verify_failed", { stage, code: errorCodeOf(error) });
  if (kind === "rate_limited") {
    await releaseTotpCode(userId, code);
    return { status: "error", message: RATE_LIMITED_MESSAGE };
  }
  if (kind === "mfa_invalid_code") {
    await recordSecondStepFailure(userId, context, clientIp);
    await auditFailure(userId, stage, kind);
    return { status: "error", message: AUTH_MESSAGES[kind] };
  }
  await releaseTotpCode(userId, code);
  await auditFailure(userId, stage, kind);
  // «La activación caducó» solo tiene sentido al activar; al ingresar, lo que sirve es volver a empezar la sesión.
  if (stage === "sign_in") return { status: "error", message: MFA_SIGN_IN_FAILED_MESSAGE };
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

  // Antes de verificar: después el pase ya no es el del enlace de recuperación. Decide también QUÉ contadores de intentos
  // se usan: quien llega con el enlace del correo y quien llega con la contraseña sola no comparten bloqueo.
  const recovery = await hasRecoverySession();
  const counters: SecondStepContext = recovery ? "recovery" : "password";
  const context = { recovery, invitation: await hasPendingInvitation() };

  const checked = await checkCodeBeforeVerifying(formData, user.id, clientIp, "sign_in", counters);
  if (!checked.ok) return checked.state;

  const factorId = state.status === "second_step_pending" ? state.factorId : null;
  if (!factorId) {
    await releaseTotpCode(user.id, checked.code);
    return { status: "error", message: MFA_SIGN_IN_FAILED_MESSAGE };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: checked.code });
  if (error) return failedVerification(error, user.id, checked.code, clientIp, "sign_in", counters);

  await clearSecondStepFailures(user.id, counters);
  await logAuditEvent({
    action: "session.mfa_verified",
    result: "success",
    actorUserId: user.id,
    details: { stage: "sign_in", factorType: MFA_FACTOR_TYPE },
  });
  // El ingreso de cada organización se escribe ahora, con la sesión ya completa (con la parcial la base no entrega ninguna).
  await logTenantLogins(supabase, user.id);
  // Reintenta los avisos de activación que no salieron (el servidor se cayó entre verificar y enviar, o el correo falló).
  // No revierte nada: quien ingresa con su código ya tiene el segundo paso activo desde antes. Nunca lanza.
  await deliverPendingEnrollmentNotices(user.id);
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

  // Contadores PROPIOS de la activación (menor 4): no comparten tope con el ingreso con contraseña.
  const checked = await checkCodeBeforeVerifying(
    formData,
    user.id,
    clientIp,
    "enrollment",
    "enrollment",
  );
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
  if (!factor) {
    await releaseTotpCode(user.id, checked.code);
    // Activar desde dos pestañas a la vez (menor 7 de la revisión de Aarón al PR #44): la otra pudo dejar la cuenta ACTIVA
    // mientras esta mostraba un intento ya reemplazado. Si hay un factor verificado, se lleva a la pantalla de seguridad,
    // que muestra la verdad («está activa»); si no, «caducó» (con la sugerencia de recargar).
    const alreadyActive =
      !listed.error &&
      listed.data.all.some(
        (entry) => entry.factor_type === MFA_FACTOR_TYPE && entry.status === "verified",
      );
    if (alreadyActive) redirect(ACCOUNT_SECURITY_PATH);
    return { status: "error", message: AUTH_MESSAGES.mfa_expired };
  }

  // El «permiso»: la base rechaza pasar un factor a verificado si nuestro servidor no lo dejó anotado justo antes (así tampoco
  // se puede activar hablando directo con Supabase, sin que salga el aviso). Vive 2 minutos.
  if (!(await permitEnrollment(user.id, factorId))) {
    await releaseTotpCode(user.id, checked.code);
    return { status: "error", message: AUTH_MESSAGES.mfa_unavailable };
  }

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: checked.code });
  // SIEMPRE, haya salido bien o mal la verificación, se atienden los avisos pendientes de la cuenta: cierra la carrera de
  // quien verifica el factor directo con el permiso vivo mientras aquí el código era incorrecto.
  const delivery = await deliverPendingEnrollmentNotices(user.id);
  await revertUnannounced(user.id, delivery, error ? null : factorId);
  if (error) {
    // El permiso ya no hace falta: un código incorrecto no deja la puerta abierta los 2 minutos.
    await closeEnrollmentPermit(user.id, factorId);
    return failedVerification(error, user.id, checked.code, clientIp, "enrollment", "enrollment");
  }

  // El factor quedó verificado. Si el aviso de ESTE factor no salió, se revierte la activación.
  if (!delivery.sentFactorIds.includes(factorId)) {
    const reverted = await revertEnrollment(user.id, factorId, failureCodeFor(delivery, factorId));
    return {
      status: "error",
      message: reverted ? MFA_NOTICE_REVERTED_MESSAGE : MFA_NOTICE_REVERT_FAILED_MESSAGE,
    };
  }

  await clearSecondStepFailures(user.id, "enrollment");
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

/** Deja el permiso de activación. `false` si la base no lo concede (el factor ya no es un TOTP sin verificar) o falla. */
async function permitEnrollment(userId: string, factorId: string): Promise<boolean> {
  try {
    return await grantEnrollmentPermit(userId, factorId);
  } catch (error) {
    await serverLog("error", "mfa_permit_failed", {
      code: error instanceof MfaAlertsGatewayError ? error.code : "unexpected",
    });
    return false;
  }
}

/**
 * Cierra el permiso de un factor cuya verificación falló. Si en ese rato alguien lo verificó directo y su aviso sigue
 * pendiente (la base lo devuelve como `pending` sin tocarlo), se revierte con el orden de siempre: PRIMERO se borra el
 * factor y solo después se anota; si el borrado falla, el aviso sigue `pending` y se reintenta. Nunca lanza.
 */
async function closeEnrollmentPermit(userId: string, factorId: string): Promise<void> {
  try {
    const outcome = await revertEnrollmentAlert(userId, factorId, "verify_failed", {
      onlyPermit: true,
    });
    if (outcome === "pending") await revertEnrollment(userId, factorId, "verify_failed");
  } catch (error) {
    await serverLog("warn", "mfa_permit_close_failed", {
      code: error instanceof MfaAlertsGatewayError ? error.code : "unexpected",
    });
  }
}

/**
 * Los avisos de OTROS factores de la cuenta que tampoco salieron (p. ej. uno verificado directo por la API con el permiso
 * vivo) también se revierten. `exceptFactorId` es el factor de esta activación, que se resuelve aparte.
 */
async function revertUnannounced(
  userId: string,
  delivery: NoticeDelivery,
  exceptFactorId: string | null,
): Promise<void> {
  for (const failure of delivery.failures) {
    if (!failure.factorId || failure.factorId === exceptFactorId) continue;
    await revertEnrollment(userId, failure.factorId, failure.code);
  }
}

/**
 * «Cancelar» durante la activación (menor 6 de la revisión de Aarón al PR #44): quita de Supabase el intento a medias, para
 * que no quede un factor sin verificar (que ocupa un cupo de la cuenta). La aplicación del teléfono no se puede limpiar desde el servidor: si la persona ya agregó «Cotiza Prime» ahí, esa entrada queda y debe borrarla ella.
 * Igual que al confirmar, el factor tiene que ser un TOTP SIN verificar de ESTA persona, visto con los factores al día: un
 * factor verificado (el que protege la cuenta) nunca se quita desde aquí. Sin llave maestra: con el pase de la persona.
 * Si no se puede quitar no pasa nada grave (la pantalla ya salió y `startTotpEnrollmentAction` limpia los restos al empezar
 * de nuevo): se registra solo el código del error y no se avisa de nada.
 */
export async function cancelTotpEnrollmentAction(factorId: string): Promise<void> {
  await requireUser();
  if (typeof factorId !== "string" || factorId === "") return;
  const supabase = await createClient();
  const listed = await supabase.auth.mfa.listFactors();
  if (listed.error) {
    await serverLog("error", "mfa_list_failed", { code: errorCodeOf(listed.error) });
    return;
  }
  const factor = listed.data.all.find(
    (entry) =>
      entry.id === factorId &&
      entry.factor_type === MFA_FACTOR_TYPE &&
      entry.status === "unverified",
  );
  if (!factor) return;
  const removed = await supabase.auth.mfa.unenroll({ factorId: factor.id });
  if (removed.error) {
    await serverLog("error", "mfa_unenroll_failed", { code: errorCodeOf(removed.error) });
  }
}
