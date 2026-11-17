import "server-only";
import { logAuditEvent } from "@/lib/audit/log";
import {
  AUTH_MESSAGES,
  MFA_LOCKED_DAY_ENROLLMENT_MESSAGE,
  MFA_LOCKED_DAY_MANAGE_MESSAGE,
  MFA_LOCKED_DAY_MESSAGE,
  MFA_LOCKED_DAY_PASSWORD_MESSAGE,
  MFA_SIGN_IN_FAILED_MESSAGE,
  classifyAuthError,
} from "@/lib/auth/errors";
import type { FormState } from "@/lib/auth/form-state";
import { fieldErrorsOf, totpCodeSchema } from "@/lib/auth/schemas";
import { MFA_FACTOR_TYPE } from "@/lib/auth/second-step";
import { serverLog } from "@/lib/log/server-log";
import {
  RATE_LIMITED_MESSAGE,
  beginSecondStepAttempt,
  consumeTotpCode,
  isSecondStepIpLocked,
  recordSecondStepFailure,
  releaseTotpCode,
  type SecondStepContext,
} from "@/lib/security/login-rate-limit";

/**
 * Lo que comparten todas las acciones que reciben el código de 6 números de la aplicación (H-004a y H-004b): ingresar,
 * activar y crear códigos de respaldo con la sesión abierta. Vive aparte de las acciones porque un archivo de acciones de
 * servidor solo puede exportar acciones.
 *
 * Reglas que se repiten aquí y no se pueden olvidar:
 * - El límite propio de intentos y el bloqueo de códigos usados van ANTES de hablar con Supabase Auth: el límite de
 *   Supabase no frena los códigos incorrectos repetidos (comprobado en el paso 0 de H-004a), así que este es el único freno.
 * - Nunca se guarda ni se registra el código, la clave ni el `uri`: `serverLog` solo recibe el código de error y la
 *   auditoría solo `{reason, stage, factorType}`.
 */

export const CODE_FIELD = "code";

export function readText(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

export type AuthErrorLike = { code?: string | null; status?: number | null };
export const errorCodeOf = (error: AuthErrorLike) => error.code ?? String(error.status ?? "");

export type CodeCheck = { ok: true; code: string } | { ok: false; state: FormState };

/** Etapa de la verificación, para la auditoría y para el mensaje de «caducó». `manage`: con la sesión ya completa. */
export type Stage = "sign_in" | "enrollment" | "manage";

/**
 * El bloqueo de 24 h con la contraseña orienta a recuperarla; el del enlace del correo no tiene esa salida; el de la
 * activación orienta a revisar la hora del teléfono; el de las acciones con la sesión abierta, a esperar.
 */
export function lockedDayMessageFor(context: SecondStepContext): string {
  if (context === "enrollment") return MFA_LOCKED_DAY_ENROLLMENT_MESSAGE;
  if (context === "manage") return MFA_LOCKED_DAY_MANAGE_MESSAGE;
  return context === "password" ? MFA_LOCKED_DAY_PASSWORD_MESSAGE : MFA_LOCKED_DAY_MESSAGE;
}

export async function auditFailure(userId: string, stage: Stage, reason: string): Promise<void> {
  await logAuditEvent({
    action: "session.mfa_failed",
    result: "failure",
    actorUserId: userId,
    details: { reason, stage, factorType: MFA_FACTOR_TYPE },
  });
}

/** Etapa para la auditoría de un intento: las de arriba y `recovery` (el camino del enlace del correo con un código de respaldo). */
export type AttemptStage = Stage | "recovery";

/**
 * El freno de los intentos, igual para todo lo que escribe un código del segundo paso (el de 6 números y, desde H-004b, el
 * de respaldo): bloqueo de la IP, tope del día de la cuenta en ese camino y la ventana de 15 minutos, que se REGISTRA aquí
 * (antes de verificar) para que los envíos en paralelo no pasen del tope. Los dos tipos de código comparten los mismos
 * contadores de un camino; los caminos entre sí, nunca. Devuelve `null` si pasa, o el estado de error que se muestra.
 */
export async function blockedAttemptState(
  userId: string,
  clientIp: string | null,
  stage: AttemptStage,
  context: SecondStepContext,
  /** Qué tipo de código se estaba probando (para la auditoría): `totp` por defecto, `recovery_code` con uno de respaldo. */
  factorType: "totp" | "recovery_code" = MFA_FACTOR_TYPE,
): Promise<FormState | null> {
  const blocked = (await isSecondStepIpLocked(clientIp))
    ? "short"
    : await beginSecondStepAttempt(userId, context);
  if (blocked === "none") return null;
  await logAuditEvent({
    action: "session.mfa_locked",
    result: "denied",
    actorUserId: userId,
    details: { reason: "blocked", stage, factorType },
  });
  return {
    status: "error",
    message: blocked === "day" ? lockedDayMessageFor(context) : RATE_LIMITED_MESSAGE,
  };
}

/**
 * Lo que va ANTES de pedirle la verificación a Supabase: formato del código, bloqueo (de la IP, del día y de la ventana de
 * 15 minutos) y código ya usado. Los intentos de la ventana se REGISTRAN aquí, antes de verificar, para que los envíos en
 * paralelo no pasen del tope. Devuelve el código limpio o el estado de error que se muestra.
 */
export async function checkCodeBeforeVerifying(
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

  const blockedState = await blockedAttemptState(userId, clientIp, stage, context);
  if (blockedState) return { ok: false, state: blockedState };

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
 * Resultado de un `challengeAndVerify` que falló, convertido en el estado que ve la persona. Solo un código incorrecto
 * suma al tope del día y al de la IP. Si Supabase falló por otra cosa (la red, la IP no coincidió, la sesión cambió) o
 * respondió 429, el código NO se juzgó: se libera para poder reintentar con el mismo código correcto. El 429 no suma al tope
 * del día ni al de la IP: no prueba nada contra la persona (puede ser el límite compartido de Supabase por una IP ajena), y
 * el intento ya contó en la ventana de 15 minutos al registrarse antes de llamar a Supabase.
 */
export async function failedVerification(
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
  // «La activación caducó» solo tiene sentido al activar; al ingresar, lo que sirve es volver a empezar la sesión; con la
  // sesión abierta (crear códigos), reintentar en unos minutos.
  if (stage === "sign_in") return { status: "error", message: MFA_SIGN_IN_FAILED_MESSAGE };
  if (stage === "manage") return { status: "error", message: AUTH_MESSAGES.mfa_unavailable };
  return { status: "error", message: AUTH_MESSAGES[kind === "unknown" ? "mfa_unavailable" : kind] };
}
