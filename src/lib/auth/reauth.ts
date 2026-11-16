import "server-only";
import { createClient as createEphemeralClient } from "@supabase/supabase-js";
import { logAuditEvent } from "@/lib/audit/log";
import { AUTH_MESSAGES, classifyAuthError } from "@/lib/auth/errors";
import { getSessionState, type SessionUser } from "@/lib/auth/session";
import { getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import {
  RATE_LIMITED_MESSAGE,
  clearLoginFailures,
  isLoginLocked,
  recordLoginFailure,
} from "@/lib/security/login-rate-limit";

/**
 * «Pedir la contraseña de nuevo» (H-004b, §3.1 del diseño): antes de activar la verificación en dos pasos (y, en las etapas
 * siguientes, de desactivarla o de crear códigos de respaldo) se vuelve a comprobar la contraseña de la persona. Protege a
 * quien deja una sesión abierta o le copian la cookie: sin la contraseña no puede activar su propio teléfono ni apagar el
 * segundo paso. No protege de quien ya sabe la contraseña: ese caso lo cubre el aviso con enlace de H-118.
 *
 * Reglas que no se pueden olvidar:
 * - El correo sale de la SESIÓN (`getSessionState`), nunca del formulario: la persona confirma SU contraseña, no la de
 *   otra cuenta.
 * - Usa el MISMO límite de intentos del ingreso (`isLoginLocked`, `recordLoginFailure`, `clearLoginFailures`): no se abre
 *   un segundo presupuesto de intentos para probar contraseñas.
 * - La comprobación abre una sesión DESECHABLE con un cliente de Supabase sin cookies ni renovación automática
 *   (`signInWithPassword`) y la cierra al instante con `signOut({ scope: "local" })`: no deja cookies ni toca las demás
 *   sesiones (comprobado en el paso 0, `tests/db/mfa-recovery-gotrue.test.ts`). Si no se logra cerrar, la sesión queda sin
 *   dueño (su renovación solo vivió en la memoria del servidor) y su pase vence solo.
 * - Un 429 de Supabase NO cuenta como contraseña incorrecta (puede ser el límite compartido por la IP del servidor).
 * - Nunca se registra la contraseña ni el correo: la auditoría lleva `{reason, purpose}` y el registro solo un código.
 */

/** Para qué se pide la contraseña (va a la auditoría). */
export type ReauthPurpose = "enroll" | "disable" | "regenerate";

export type ReauthFailureReason =
  "wrong_password" | "locked" | "rate_limited" | "other_account" | "unavailable";

export type ReauthResult =
  { ok: true } | { ok: false; reason: ReauthFailureReason; message: string };

export const REAUTH_WRONG_PASSWORD_MESSAGE = "La contraseña no es correcta.";
export const REAUTH_UNAVAILABLE_MESSAGE =
  "No pudimos comprobar tu contraseña. Intenta de nuevo en unos minutos.";

/** Cuánto se espera, como máximo, la respuesta de Supabase al comprobar la contraseña. */
const SIGN_IN_TIMEOUT_MS = 10_000;

const fail = (reason: ReauthFailureReason, message: string): ReauthResult => ({
  ok: false,
  reason,
  message,
});

async function auditFailure(
  user: SessionUser,
  reason: ReauthFailureReason,
  purpose: ReauthPurpose,
): Promise<void> {
  await logAuditEvent({
    action: "session.reauth_failed",
    result: reason === "locked" ? "denied" : "failure",
    actorUserId: user.id,
    details: { reason, purpose },
  });
}

type AuthErrorLike = { code?: string | null; status?: number | null };
const errorCodeOf = (error: AuthErrorLike) => error.code ?? String(error.status ?? "");

/** Un cliente sin cookies, sin renovación automática y sin leer la dirección: lo único que guarda es la memoria de esta llamada. */
function createDisposableClient() {
  return createEphemeralClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS) }),
      },
    },
  );
}

/**
 * Comprueba la contraseña de la persona de la sesión. `user` es quien la acción ya identificó (`requireUser()`); el correo
 * sale de la sesión, no del formulario. Devuelve `{ ok: true }` o el motivo con el mensaje que se le muestra. Nunca lanza.
 */
export async function confirmPassword(
  user: SessionUser,
  password: string,
  purpose: ReauthPurpose,
): Promise<ReauthResult> {
  const state = await getSessionState();
  // El correo viene de la sesión verificada; si la sesión no es la de `user`, no se comprueba nada.
  if (state.status === "signed_out" || state.user.id !== user.id || !state.user.email) {
    await auditFailure(user, "other_account", purpose);
    return fail("other_account", REAUTH_UNAVAILABLE_MESSAGE);
  }
  const email = state.user.email;
  const { clientIp } = await getRequestContext();

  // El mismo bloqueo del ingreso: si la cuenta o la IP están bloqueadas, ni se consulta a Supabase.
  if (await isLoginLocked(email, clientIp)) {
    await auditFailure(user, "locked", purpose);
    return fail("locked", RATE_LIMITED_MESSAGE);
  }

  const client = createDisposableClient();
  let signedInUserId: string | null = null;
  let signInError: AuthErrorLike | null = null;
  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    signInError = error;
    signedInUserId = data.user?.id ?? null;
    if (!error && !data.user) signInError = { code: "no_user" };
  } catch {
    // Sin respuesta de Supabase (red, plazo): no se juzgó la contraseña, no suma fallo.
    await serverLog("error", "reauth_sign_in_failed", { code: "unexpected" });
    await auditFailure(user, "unavailable", purpose);
    return fail("unavailable", REAUTH_UNAVAILABLE_MESSAGE);
  }

  // La sesión desechable se cierra SIEMPRE que haya llegado a abrirse, también si la cuenta no era la esperada.
  if (signedInUserId) await closeDisposableSession(client);

  if (signInError) {
    const kind = classifyAuthError(signInError);
    if (kind === "rate_limited") {
      await auditFailure(user, "rate_limited", purpose);
      return fail("rate_limited", AUTH_MESSAGES.rate_limited);
    }
    if (kind === "invalid_credentials") {
      // Solo la contraseña incorrecta cuenta; si con este fallo queda bloqueada, se le dice como en el ingreso.
      const nowLocked = await recordLoginFailure(email, clientIp);
      await auditFailure(user, nowLocked ? "locked" : "wrong_password", purpose);
      return nowLocked
        ? fail("locked", RATE_LIMITED_MESSAGE)
        : fail("wrong_password", REAUTH_WRONG_PASSWORD_MESSAGE);
    }
    await serverLog("warn", "reauth_sign_in_failed", { code: errorCodeOf(signInError) });
    await auditFailure(user, "unavailable", purpose);
    return fail("unavailable", REAUTH_UNAVAILABLE_MESSAGE);
  }

  // Lo que respondió Supabase tiene que ser la misma persona de la sesión.
  if (signedInUserId !== user.id) {
    await auditFailure(user, "other_account", purpose);
    return fail("other_account", REAUTH_UNAVAILABLE_MESSAGE);
  }

  await clearLoginFailures(email);
  return { ok: true };
}

/** Cierra solo la sesión desechable. Si no se logra, se registra únicamente el código del error. Nunca lanza. */
async function closeDisposableSession(
  client: ReturnType<typeof createDisposableClient>,
): Promise<void> {
  try {
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) await serverLog("warn", "reauth_sign_out_failed", { code: errorCodeOf(error) });
  } catch {
    await serverLog("warn", "reauth_sign_out_failed", { code: "unexpected" });
  }
}
