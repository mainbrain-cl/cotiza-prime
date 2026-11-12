"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { logAuditEvent } from "@/lib/audit/log";
import { AUTH_MESSAGES, classifyAuthError } from "@/lib/auth/errors";
import { logTenantLogins } from "@/lib/auth/login-audit";
import type { FormState } from "@/lib/auth/form-state";
import {
  ACCEPT_TERMS_PATH,
  AUTH_CALLBACK_PATH,
  AUTH_RECOVERY_PATH,
  HOME_PATH,
  LOGIN_NOTICES,
  LOGIN_PATH,
  SECOND_STEP_PATH,
} from "@/lib/auth/paths";
import {
  fieldErrorsOf,
  forgotPasswordSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
} from "@/lib/auth/schemas";
import {
  clearRecoverySession,
  getOptionalUser,
  getSessionState,
  hasRecoverySession,
  requireUser,
} from "@/lib/auth/session";
import { getAppOrigin, getRequestContext } from "@/lib/http/request-context";
import { legalDocuments } from "@/lib/legal/documents";
import { serverLog } from "@/lib/log/server-log";
import {
  RATE_LIMITED_MESSAGE,
  clearLoginFailures,
  clearPasswordPathSecondStepCounters,
  emailFingerprint,
  isLoginLocked,
  isResetLocked,
  isSignupLocked,
  recordLoginFailure,
  recordResetRequest,
  recordSignupAttempt,
} from "@/lib/security/login-rate-limit";
import { deliverPendingEnrollmentNotices } from "@/lib/security/mfa-enrollment-notice";
import { createClient } from "@/lib/supabase/server";
import { INVITATION_ACCEPT_PATH } from "@/lib/team/accept-model";
import { clearInvitationCode, hasPendingInvitation } from "@/lib/team/invitation-cookie";
import { CLIENT_IP_HEADER } from "@/lib/tenant/constants";

/** Prefijo de las cookies de sesión que crea Supabase (`sb-<proyecto>-auth-token`). */
const SUPABASE_COOKIE_PREFIX = "sb-";

function readText(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

/** H-001: crea la cuenta y manda el correo de verificación. Nunca revela si el correo ya existía. */
export async function signUpAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const raw = {
    fullName: readText(formData, "fullName"),
    email: readText(formData, "email"),
    password: readText(formData, "password"),
    acceptLegal: readText(formData, "acceptLegal"),
  };
  const values = { fullName: raw.fullName ?? "", email: raw.email ?? "" };

  const parsed = signUpSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values };
  }

  // Límite por IP contra el registro masivo de cuentas. Cada intento cuenta.
  const { clientIp } = await getRequestContext();
  if (await isSignupLocked(clientIp)) {
    return { status: "error", message: RATE_LIMITED_MESSAGE, values };
  }
  await recordSignupAttempt(clientIp);

  const supabase = await createClient();
  const origin = getAppOrigin();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${origin}${AUTH_CALLBACK_PATH}`,
      // Las versiones aceptadas viajan con la cuenta; la base las registra solo si son las vigentes.
      data: {
        full_name: parsed.data.fullName,
        accepted_legal: {
          terms: legalDocuments.terms.version,
          privacy: legalDocuments.privacy.version,
        },
      },
    },
  });

  if (error) {
    const kind = classifyAuthError(error);
    if (kind === "weak_password") {
      return { status: "error", fieldErrors: { password: AUTH_MESSAGES.weak_password }, values };
    }
    // "Cuenta ya existe" no se distingue del éxito: no se revela quién tiene cuenta.
    if (error.code !== "user_already_exists" && error.code !== "email_exists") {
      return { status: "error", message: AUTH_MESSAGES[kind], values };
    }
  }

  return { status: "sent", values: { email: parsed.data.email } };
}

/** H-002: ingresar con correo y contraseña. */
export async function signInAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const raw = { email: readText(formData, "email"), password: readText(formData, "password") };
  const values = { email: raw.email ?? "" };

  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values };
  }

  const { clientIp } = await getRequestContext();
  const emailHash = emailFingerprint(parsed.data.email);

  // Límite propio de intentos: por cuenta y por IP real. Si está bloqueado ni se consulta a Supabase.
  if (await isLoginLocked(parsed.data.email, clientIp)) {
    await logAuditEvent({
      action: "session.login_locked",
      result: "denied",
      details: { emailHash, stage: "blocked" },
    });
    return { status: "error", message: RATE_LIMITED_MESSAGE, values };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error || !data.user) {
    const kind = error ? classifyAuthError(error) : "invalid_credentials";
    // Sin correo ni contraseña en el registro: solo el motivo y la huella del correo.
    await logAuditEvent({
      action: "session.login_failed",
      result: "failure",
      details: { reason: kind, emailHash },
    });

    // Solo cuenta la contraseña incorrecta: un correo sin verificar o una caída no bloquean a nadie.
    if (kind === "invalid_credentials" && (await recordLoginFailure(parsed.data.email, clientIp))) {
      await logAuditEvent({
        action: "session.login_locked",
        result: "denied",
        details: { emailHash, stage: "threshold_reached" },
      });
      return { status: "error", message: RATE_LIMITED_MESSAGE, values };
    }
    return { status: "error", message: AUTH_MESSAGES[kind], values };
  }

  await clearLoginFailures(parsed.data.email);
  // Con la verificación en dos pasos activa, la contraseña no basta: la sesión queda parcial y falta el código. El ingreso
  // de la plataforma queda anotado como «solo contraseña, falta el código»: quien lee el registro no puede confundirlo con
  // una sesión completa. El ingreso de cada organización se escribe después del código (con la sesión parcial la base no
  // entrega ninguna). Para cuentas sin la verificación activa, nada cambia.
  const secondStepPending = (data.user.factors ?? []).some(
    (factor) => factor.status === "verified",
  );
  await logAuditEvent({
    action: "session.login",
    result: "success",
    actorUserId: data.user.id,
    ...(secondStepPending ? { details: { stage: "password", secondStepPending: true } } : {}),
  });
  if (secondStepPending) {
    // Quien llega aquí con la contraseña de una cuenta con el segundo paso (p. ej. la dueña que quedó fuera tras una activación
    // ajena) reintenta los avisos de activación que no salieron. El aviso va SIEMPRE al correo de la cuenta (de la base) y no
    // dice nada a quien lo pide; el tope es de la base: 5 intentos por aviso y uno cada 20 segundos (`mfa_alerts_reserve`),
    // además del límite de intentos de ingreso de arriba. Nunca lanza.
    await deliverPendingEnrollmentNotices(data.user.id);
    redirect(SECOND_STEP_PATH);
  }
  // Además, un ingreso por cada organización de la persona: así cada Dueño ve cuándo entra su equipo.
  await logTenantLogins(supabase, data.user.id);
  // Si la persona venía de abrir el enlace de una invitación, vuelve a ella para unirse (H-009).
  redirect((await hasPendingInvitation()) ? INVITATION_ACCEPT_PATH : HOME_PATH);
}

/**
 * H-002: cierre efectivo. Invalida la sesión en el servidor de autenticación y borra las cookies.
 * Si el servidor de autenticación no responde, igual se borran a mano las cookies de este
 * navegador y se avisa con un mensaje distinto al de éxito: la sesión pudo quedar activa en el servidor.
 *
 * `keepInvitation`: el cierre normal también borra la invitación guardada en este navegador (H-009): en un
 * computador compartido, quien ingrese después no debe caer en la invitación de otra persona. Solo el botón
 * «Cerrar sesión e ingresar con otro correo» de la propia invitación la conserva.
 */
async function performSignOut(keepInvitation: boolean): Promise<void> {
  // La sesión parcial (falta el código de la verificación en dos pasos) también cierra y también queda en la auditoría.
  const state = await getSessionState();
  const user = state.status === "signed_out" ? null : state.user;
  const supabase = await createClient();
  // `local`: cierra esta sesión y deja las de otros dispositivos.
  const { error } = await supabase.auth.signOut({ scope: "local" });

  if (error) {
    await serverLog("error", "signout_failed", { code: error.code ?? String(error.status ?? "") });
    const cookieStore = await cookies();
    for (const cookie of cookieStore.getAll()) {
      if (cookie.name.startsWith(SUPABASE_COOKIE_PREFIX)) cookieStore.delete(cookie.name);
    }
  }
  if (!keepInvitation) await clearInvitationCode();
  if (user) {
    await logAuditEvent({
      action: "session.logout",
      result: error ? "failure" : "success",
      actorUserId: user.id,
    });
  }
  redirect(
    `${LOGIN_PATH}?aviso=${error ? LOGIN_NOTICES.signOutIncomplete : LOGIN_NOTICES.signedOut}`,
  );
}

/** Cierre de sesión normal: también borra la invitación guardada en este navegador. */
export async function signOutAction(): Promise<void> {
  await performSignOut(false);
}

/** «Cerrar sesión e ingresar con otro correo» (pantalla de la invitación): conserva la invitación para seguir. */
export async function signOutKeepingInvitationAction(): Promise<void> {
  await performSignOut(true);
}

/**
 * H-003: pide el enlace para elegir una contraseña nueva. La respuesta es la misma exista o no la
 * cuenta (también cuando Supabase falla o limita el envío): no se revela quién tiene cuenta.
 * Solo el límite propio de pedidos (por cuenta y por IP) responde distinto, y cuenta todo pedido.
 */
export async function requestPasswordResetAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = { email: readText(formData, "email") };
  const values = { email: raw.email ?? "" };

  const parsed = forgotPasswordSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values };
  }

  const { clientIp } = await getRequestContext();
  const emailHash = emailFingerprint(parsed.data.email);

  if (await isResetLocked(parsed.data.email, clientIp)) {
    await logAuditEvent({
      action: "session.password_reset_requested",
      result: "denied",
      details: { emailHash, stage: "blocked" },
    });
    return { status: "error", message: RATE_LIMITED_MESSAGE, values };
  }
  await recordResetRequest(parsed.data.email, clientIp);

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${getAppOrigin()}${AUTH_RECOVERY_PATH}`,
  });
  if (error) {
    await serverLog("error", "password_reset_request_failed", {
      code: error.code ?? String(error.status ?? ""),
    });
  }
  await logAuditEvent({
    action: "session.password_reset_requested",
    result: error ? "failure" : "success",
    details: { emailHash },
  });

  return { status: "sent", values: { email: parsed.data.email } };
}

/**
 * H-003: guarda la contraseña nueva. Quien llega aquí tiene una sesión abierta con el enlace del
 * correo. Al cambiarla se cierran todas las demás sesiones de la cuenta (esta se mantiene).
 * El aviso por correo de que la contraseña cambió lo envía Supabase Auth (supabase/config.toml).
 */
export async function resetPasswordAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await getOptionalUser();
  if (!user || !(await hasRecoverySession())) {
    redirect(`${LOGIN_PATH}?aviso=${LOGIN_NOTICES.resetLinkExpired}`);
  }

  const parsed = resetPasswordSchema.safeParse({
    password: readText(formData, "password"),
    confirmPassword: readText(formData, "confirmPassword"),
  });
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error) };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    const kind = classifyAuthError(error);
    await logAuditEvent({
      action: "session.password_changed",
      result: "failure",
      actorUserId: user.id,
      details: { reason: kind },
    });
    if (kind === "weak_password" || kind === "same_password") {
      return { status: "error", fieldErrors: { password: AUTH_MESSAGES[kind] } };
    }
    return { status: "error", message: AUTH_MESSAGES[kind] };
  }

  // Cierra las sesiones de otros dispositivos. Si falla, la contraseña ya cambió: se avisa en el
  // registro y se deja constancia, pero no se le dice a la persona que no cambió.
  const { error: othersError } = await supabase.auth.signOut({ scope: "others" });
  if (othersError) {
    await serverLog("error", "signout_others_failed", {
      code: othersError.code ?? String(othersError.status ?? ""),
    });
  }
  await logAuditEvent({
    action: "session.password_changed",
    result: "success",
    actorUserId: user.id,
    details: { otherSessionsClosed: !othersError },
  });
  // La contraseña vieja ya no sirve: los fallos de código acumulados con ella (y el bloqueo de 24 h) dejan de valer. No toca el
  // camino de recuperación por correo ni la IP. Si falla, no se corta el cambio (el limpiador avisa en el registro).
  await clearPasswordPathSecondStepCounters(user.id);
  await clearRecoverySession();
  redirect(HOME_PATH);
}

/** H-110: "Acepta la nueva versión". Registra la aceptación de los documentos vigentes. */
export async function acceptLegalAction(): Promise<void> {
  await requireUser({ skipLegalGate: true });
  const context = await getRequestContext();
  const supabase = await createClient(
    context.clientIp ? { [CLIENT_IP_HEADER]: context.clientIp } : undefined,
  );
  const { error } = await supabase.rpc("accept_current_legal_documents");
  if (error) redirect(`${ACCEPT_TERMS_PATH}?error=1`);
  // Quien venía de una invitación (se registró y debe aceptar términos nuevos) vuelve a ella para unirse.
  redirect((await hasPendingInvitation()) ? INVITATION_ACCEPT_PATH : HOME_PATH);
}
