"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { getAntibotVerifier } from "@/lib/antibot";
import { logAuditEvent } from "@/lib/audit/log";
import {
  CONFIRM_RETRY_MESSAGE,
  SETUP_EXPIRED_MESSAGE,
  SETUP_FAILED_MESSAGE,
  SIGNUP_ANTIBOT_ACTION,
  SIGNUP_MIN_RESPONSE_MS,
  rejectionFor,
  rejectionState,
  setupResponseSchema,
  type ConfirmEmailState,
  type CreateAccountState,
} from "@/lib/auth/account-setup";
import { AUTH_MESSAGES, classifyAuthError } from "@/lib/auth/errors";
import type { FormState } from "@/lib/auth/form-state";
import { CREATE_ACCOUNT_PATH, NEW_TENANT_PATH, SECOND_STEP_PATH } from "@/lib/auth/paths";
import {
  ANTIBOT_MISSING_MESSAGE,
  createAccountSchema,
  fieldErrorsOf,
  signUpSchema,
} from "@/lib/auth/schemas";
import { getSessionState, hasEmailLinkSession, isAccountReady } from "@/lib/auth/session";
import { sendSignupLink } from "@/lib/auth/signup-service";
import { getAppOrigin, getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import {
  RATE_LIMITED_MESSAGE,
  consumeSignupLinkQuota,
  emailFingerprint,
  isSignupLocked,
  recordSignupAttempt,
} from "@/lib/security/login-rate-limit";
import { createClient } from "@/lib/supabase/server";
import { INVITATION_ACCEPT_PATH } from "@/lib/team/accept-model";
import { hasPendingInvitation } from "@/lib/team/invitation-cookie";
import { CLIENT_IP_HEADER } from "@/lib/tenant/constants";

/**
 * El registro en dos pasos (H-116): 1) `signUpAction`: solo el correo; 2) `confirmEmailLinkAction`: canjear el enlace del
 * correo (un clic, nunca al abrir la página); 3) `completeAccountSetupAction`: nombre, contraseña y términos, desde la sesión
 * que abrió ese enlace. Diseño y razones: `docs/arquitectura/h-116-registro-seguro.md`.
 */

/** Cuántas veces se intenta cerrar las otras sesiones y terminar la cuenta si la base todavía ve otra sesión abierta. */
const OTHER_SESSIONS_RETRIES = 1;
const MAX_TOKEN_HASH_LENGTH = 256;
const TOKEN_HASH_PATTERN = /^[A-Za-z0-9._-]+$/;
const HTTP_SERVER_ERROR = 500;
const ANTIBOT_FAILED_MESSAGE = "No pudimos comprobar que eres una persona. Inténtalo de nuevo.";

function readText(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

async function waitUntil(startedAtMs: number, minimumMs: number): Promise<void> {
  const remaining = startedAtMs + minimumMs - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

/**
 * Paso 1 (`/registro`): pide el enlace. La respuesta es la MISMA exista o no la cuenta (también si el correo falla después):
 * no se revela quién tiene cuenta. El trabajo caro (preparar la cuenta y enviar el correo) corre después de responder y la
 * respuesta dura al menos `SIGNUP_MIN_RESPONSE_MS`. Solo responden distinto los topes (por IP y por correo), que cuentan todo
 * pedido, y la prueba anti-robot.
 */
export async function signUpAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const startedAt = Date.now();
  const raw = {
    email: readText(formData, "email"),
    antibotToken: readText(formData, "antibotToken"),
  };
  const values = { email: raw.email ?? "" };

  const parsed = signUpSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values };
  }
  const { email, antibotToken } = parsed.data;
  const { clientIp } = await getRequestContext();
  const emailHash = emailFingerprint(email);

  // Límite por IP contra el registro masivo. Cada intento cuenta.
  if (await isSignupLocked(clientIp)) {
    await logAuditEvent({
      action: "session.signup_requested",
      result: "denied",
      details: { emailHash, stage: "blocked_ip" },
    });
    return { status: "error", message: RATE_LIMITED_MESSAGE, values };
  }
  await recordSignupAttempt(clientIp);

  // Anti-robot (decisión 019). Si el proveedor no responde, se bloquea (falla cerrado).
  let verdict: Awaited<ReturnType<ReturnType<typeof getAntibotVerifier>["verify"]>>;
  try {
    verdict = await getAntibotVerifier().verify({
      token: antibotToken,
      remoteIp: clientIp,
      expectedHostname: new URL(getAppOrigin()).hostname,
      expectedAction: SIGNUP_ANTIBOT_ACTION,
    });
  } catch (cause) {
    await serverLog("error", "signup_antibot_unavailable", {
      code: cause instanceof Error ? cause.name : "unknown",
    });
    return { status: "error", message: ANTIBOT_FAILED_MESSAGE, values };
  }
  if (!verdict.ok) {
    await serverLog("warn", "signup_blocked", { reason: `antibot_${verdict.reason}` });
    return {
      status: "error",
      message:
        verdict.reason === "missing_token" ? ANTIBOT_MISSING_MESSAGE : ANTIBOT_FAILED_MESSAGE,
      values,
    };
  }

  // Tope por correo: 1 enlace por minuto y 3 por hora. Cuenta el pedido exista o no la cuenta.
  if (!(await consumeSignupLinkQuota(email))) {
    await logAuditEvent({
      action: "session.signup_requested",
      result: "denied",
      details: { emailHash, stage: "blocked_email" },
    });
    return { status: "error", message: RATE_LIMITED_MESSAGE, values };
  }
  await logAuditEvent({
    action: "session.signup_requested",
    result: "success",
    details: { emailHash },
  });

  // El trabajo caro, DESPUÉS de responder: así nada de lo que ve la persona depende de si el correo ya tenía cuenta.
  after(async () => {
    await sendSignupLink(email);
  });
  await waitUntil(startedAt, SIGNUP_MIN_RESPONSE_MS);
  return { status: "sent", values: { email } };
}

/**
 * Paso 2 (`/confirmar-correo`): «Continuar». Canjea el código del enlace por una sesión y lleva a `/crear-cuenta`. Solo el
 * clic lo gasta (al abrir la página no pasa nada: los antivirus de correo abren los enlaces antes que la persona). El tipo del
 * enlace es siempre `invite`; el que llegue en la dirección no se usa.
 */
export async function confirmEmailLinkAction(
  _previous: ConfirmEmailState,
  formData: FormData,
): Promise<ConfirmEmailState> {
  const tokenHash = readText(formData, "token_hash")?.trim();
  if (
    !tokenHash ||
    tokenHash.length > MAX_TOKEN_HASH_LENGTH ||
    !TOKEN_HASH_PATTERN.test(tokenHash)
  ) {
    return { status: "error", expired: true };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "invite" });
  if (error || !data.session) {
    if (error) {
      const retryable = error.status === undefined || error.status >= HTTP_SERVER_ERROR;
      const limited = classifyAuthError(error) === "rate_limited";
      if (retryable || limited) {
        await serverLog("warn", "signup_confirm_failed", {
          code: error.code ?? String(error.status ?? "network"),
        });
        return {
          status: "error",
          message: limited ? AUTH_MESSAGES.rate_limited : CONFIRM_RETRY_MESSAGE,
        };
      }
    }
    // Se usó, venció o no existe: no se distingue cuál.
    return { status: "error", expired: true };
  }
  redirect(CREATE_ACCOUNT_PATH);
}

/** A dónde va quien terminó su cuenta: a unirse, si venía de una invitación; si no, a crear su primera organización. */
async function nextPathAfterSetup(): Promise<string> {
  return (await hasPendingInvitation()) ? INVITATION_ACCEPT_PATH : NEW_TENANT_PATH;
}

/**
 * Lo que vuelve a la pantalla tras un rechazo: si cambiaron los términos o la política, la casilla NO se conserva (hay que leerlos
 * y aceptarlos de nuevo).
 */
function valuesAfter(result: string, values: Record<string, string>): Record<string, string> {
  if (result !== "legal_changed") return values;
  const rest = { ...values };
  delete rest.acceptLegal;
  return rest;
}

/** El error de una función de la base que se LANZA (sin sesión, sesión cerrada, segundo paso pendiente, solo lectura). */
function thrownRejection(error: { code?: string | null; message?: string | null }) {
  if (error.message === "second_step_required") redirect(SECOND_STEP_PATH);
  if (error.message === "session_closed" || error.message === "not_authenticated") {
    return { message: SETUP_EXPIRED_MESSAGE, expired: true } as const;
  }
  return { message: SETUP_FAILED_MESSAGE } as const;
}

/**
 * Paso 3 (`/crear-cuenta`): nombre, contraseña y términos, desde la sesión que abrió el enlace del correo. Orden fijo (lo
 * que se fija primero es lo que la base va a rechazar, para no dejar una contraseña puesta en una cuenta que no se termina):
 *
 *  1. sesión y cuenta: sin sesión o ya terminada se resuelve sin tocar nada; la sesión tiene que venir de un enlace del
 *     correo (`hasEmailLinkSession`); los datos se validan.
 *  2. `account_setup_preflight`: los mismos chequeos de la base, SIN escribir.
 *  3. `updateUser({ password })`: la primera contraseña real (`same_password` cuenta como hecho: es un reintento).
 *  4. `signOut({ scope: "others" })`: nadie más que esta sesión conserva un pase que sirva.
 *  5. `complete_account_setup`: guarda el nombre y los términos y marca la cuenta como terminada. Si la base ve otra sesión
 *     abierta (`other_sessions`), se repite el cierre y se reintenta una vez.
 *
 * Los rechazos de la base llegan como `{ result }` (no como error): cada uno tiene su mensaje (`account-setup.ts`).
 */
export async function completeAccountSetupAction(
  _previous: CreateAccountState,
  formData: FormData,
): Promise<CreateAccountState> {
  const session = await getSessionState();
  if (session.status === "signed_out") {
    return { status: "error", message: SETUP_EXPIRED_MESSAGE, expired: true };
  }
  if (session.status === "second_step_pending") redirect(SECOND_STEP_PATH);
  // Ya terminada (doble clic, o un reintento después de terminar): no se toca la contraseña, se sigue de largo.
  if (await isAccountReady()) redirect(await nextPathAfterSetup());
  if (!(await hasEmailLinkSession())) {
    return { status: "error", message: SETUP_EXPIRED_MESSAGE, expired: true };
  }

  // Lo escrito vuelve a la pantalla tras un error (React vacía el formulario al terminar la acción): el nombre y la casilla de
  // los términos. Nunca las contraseñas.
  const fullName = readText(formData, "fullName") ?? "";
  const values: Record<string, string> = {
    fullName,
    ...(readText(formData, "acceptLegal") === "on" ? { acceptLegal: "on" } : {}),
  };
  const parsed = createAccountSchema.safeParse({
    fullName: readText(formData, "fullName"),
    password: readText(formData, "password"),
    confirmPassword: readText(formData, "confirmPassword"),
    acceptLegal: readText(formData, "acceptLegal"),
    termsVersion: readText(formData, "termsVersion"),
    privacyVersion: readText(formData, "privacyVersion"),
  });
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values };
  }
  const input = parsed.data;
  const setupArgs = {
    p_full_name: input.fullName,
    p_terms_version: input.termsVersion,
    p_privacy_version: input.privacyVersion,
  };

  // Un solo cliente con la IP y el navegador de quien termina: la base los guarda con la aceptación de los términos.
  const context = await getRequestContext();
  const supabase = await createClient({
    ...(context.clientIp ? { [CLIENT_IP_HEADER]: context.clientIp } : {}),
    ...(context.userAgent ? { "user-agent": context.userAgent } : {}),
  });

  // 2. Validar sin escribir.
  const preflight = await supabase.rpc("account_setup_preflight", setupArgs);
  if (preflight.error) return rejectionState(thrownRejection(preflight.error), values);
  const checked = setupResponseSchema.safeParse(preflight.data);
  if (!checked.success) {
    await serverLog("error", "account_setup_failed", { stage: "preflight", code: "shape" });
    return rejectionState({ message: SETUP_FAILED_MESSAGE }, values);
  }
  if (checked.data.result !== "ok")
    return rejectionState(
      rejectionFor(checked.data.result),
      valuesAfter(checked.data.result, values),
    );

  // 3. La primera contraseña real.
  const updated = await supabase.auth.updateUser({ password: input.password });
  if (updated.error) {
    const kind = classifyAuthError(updated.error);
    // Un reintento: la contraseña ya quedó puesta la vez anterior.
    if (kind !== "same_password") {
      if (kind === "weak_password") {
        return {
          status: "error",
          fieldErrors: { password: AUTH_MESSAGES.weak_password },
          values,
        };
      }
      if (kind === "reauthentication_needed") {
        return { status: "error", message: SETUP_EXPIRED_MESSAGE, expired: true, values };
      }
      await serverLog("warn", "account_setup_failed", {
        stage: "password",
        code: updated.error.code ?? String(updated.error.status ?? ""),
      });
      return { status: "error", message: AUTH_MESSAGES[kind], values };
    }
  }

  // 4 y 5. Cerrar las otras sesiones y terminar la cuenta.
  for (let attempt = 0; attempt <= OTHER_SESSIONS_RETRIES; attempt += 1) {
    const others = await supabase.auth.signOut({ scope: "others" });
    if (others.error) {
      // Si quedó otra sesión abierta, la base lo dice (`other_sessions`) y se reintenta; si no, no pasó nada.
      await serverLog("warn", "account_setup_signout_others_failed", {
        code: others.error.code ?? String(others.error.status ?? ""),
      });
    }
    const completed = await supabase.rpc("complete_account_setup", setupArgs);
    if (completed.error) {
      await serverLog("warn", "account_setup_failed", {
        stage: "complete",
        code: completed.error.message ?? completed.error.code ?? "unknown",
      });
      return rejectionState(thrownRejection(completed.error), values);
    }
    const answer = setupResponseSchema.safeParse(completed.data);
    if (!answer.success) {
      await serverLog("error", "account_setup_failed", { stage: "complete", code: "shape" });
      return rejectionState({ message: SETUP_FAILED_MESSAGE }, values);
    }
    if (answer.data.result === "completed") redirect(await nextPathAfterSetup());
    if (answer.data.result === "other_sessions" && attempt < OTHER_SESSIONS_RETRIES) continue;
    return rejectionState(
      rejectionFor(answer.data.result),
      valuesAfter(answer.data.result, values),
    );
  }
  return rejectionState({ message: SETUP_FAILED_MESSAGE }, values);
}
