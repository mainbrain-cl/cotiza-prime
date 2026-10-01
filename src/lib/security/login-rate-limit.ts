import "server-only";
import { searchHash } from "@/lib/crypto/search-hash";
import { serverLog } from "@/lib/log/server-log";
import { normalizeEmail } from "@/lib/normalize/email";
import { createAdminClient } from "@/lib/supabase/admin-client";
import { PLATFORM_TENANT_ID } from "@/lib/tenant/constants";

// Límite de intentos de ingreso y registro (SEGURIDAD.md §1, H-002). Solo cuentan los FALLOS:
// quien ingresa bien nunca queda bloqueado por haber ingresado muchas veces.
// Los contadores viven en `auth_rate_limits`; las claves son huellas HMAC, nunca el correo ni la IP.

const SECONDS_PER_MINUTE = 60;

/** Fallos de contraseña permitidos por cuenta dentro de la ventana. */
export const LOGIN_MAX_FAILURES_PER_ACCOUNT = 5;
/** Fallos permitidos desde una misma IP (muchas cuentas probadas desde un solo lugar). */
export const LOGIN_MAX_FAILURES_PER_IP = 20;
export const LOGIN_WINDOW_SECONDS = 15 * SECONDS_PER_MINUTE;
export const LOGIN_LOCK_SECONDS = 15 * SECONDS_PER_MINUTE;

/** Cuentas que se pueden crear desde una misma IP dentro de la ventana. */
export const SIGNUP_MAX_ATTEMPTS_PER_IP = 10;
export const SIGNUP_WINDOW_SECONDS = 15 * SECONDS_PER_MINUTE;
export const SIGNUP_LOCK_SECONDS = 15 * SECONDS_PER_MINUTE;

/** Mensaje único: no revela si el correo existe ni cuál de los límites se alcanzó. */
export const RATE_LIMITED_MESSAGE =
  "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.";

export type RateLimitScope = "login_email" | "login_ip" | "signup_ip";

type Rule = { maxFailures: number; windowSeconds: number; lockSeconds: number };

const RULES: Record<RateLimitScope, Rule> = {
  login_email: {
    maxFailures: LOGIN_MAX_FAILURES_PER_ACCOUNT,
    windowSeconds: LOGIN_WINDOW_SECONDS,
    lockSeconds: LOGIN_LOCK_SECONDS,
  },
  login_ip: {
    maxFailures: LOGIN_MAX_FAILURES_PER_IP,
    windowSeconds: LOGIN_WINDOW_SECONDS,
    lockSeconds: LOGIN_LOCK_SECONDS,
  },
  signup_ip: {
    maxFailures: SIGNUP_MAX_ATTEMPTS_PER_IP,
    windowSeconds: SIGNUP_WINDOW_SECONDS,
    lockSeconds: SIGNUP_LOCK_SECONDS,
  },
};

/** Huella de un correo, para el contador y para la auditoría (nunca el correo en claro). */
export function emailFingerprint(email: string): string {
  return searchHash("login_email", PLATFORM_TENANT_ID, normalizeEmail(email));
}

function ipFingerprint(scope: "login_ip" | "signup_ip", ip: string): string {
  return searchHash(scope, PLATFORM_TENANT_ID, ip);
}

type Target = { scope: RateLimitScope; keyHash: string };

function loginTargets(email: string, ip: string | null): Target[] {
  const targets: Target[] = [{ scope: "login_email", keyHash: emailFingerprint(email) }];
  // Sin IP conocida no se limita por IP (un solo grupo "desconocido" bloquearía a todos); sigue
  // vigente el límite por cuenta.
  if (ip) targets.push({ scope: "login_ip", keyHash: ipFingerprint("login_ip", ip) });
  return targets;
}

function signupTargets(ip: string | null): Target[] {
  return ip ? [{ scope: "signup_ip", keyHash: ipFingerprint("signup_ip", ip) }] : [];
}

async function anyLocked(targets: Target[]): Promise<boolean> {
  const admin = createAdminClient();
  for (const target of targets) {
    const { data, error } = await admin.rpc("auth_limit_locked_until", {
      p_scope: target.scope,
      p_key_hash: target.keyHash,
    });
    if (error) throw new Error(error.code ?? "rate_limit_read_failed");
    if (data) return true;
  }
  return false;
}

/** Suma un fallo a cada objetivo. Devuelve si alguno quedó bloqueado. */
async function recordAll(targets: Target[]): Promise<boolean> {
  const admin = createAdminClient();
  let locked = false;
  for (const target of targets) {
    const rule = RULES[target.scope];
    const { data, error } = await admin.rpc("auth_limit_record_failure", {
      p_scope: target.scope,
      p_key_hash: target.keyHash,
      p_max_failures: rule.maxFailures,
      p_window_seconds: rule.windowSeconds,
      p_lock_seconds: rule.lockSeconds,
    });
    if (error) throw new Error(error.code ?? "rate_limit_write_failed");
    if (data) locked = true;
  }
  return locked;
}

/**
 * Si el contador falla (la base no responde), se deja pasar y se avisa en el log: no se corta el
 * ingreso de todos por una falla del limitador. El límite propio de Supabase Auth sigue vigente.
 */
async function failOpen<T>(operation: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    await serverLog("error", "rate_limit_unavailable", {
      operation,
      code: error instanceof Error ? error.message.slice(0, 40) : "unknown",
    });
    return fallback;
  }
}

/** ¿Esta cuenta o esta IP está bloqueada para ingresar? */
export function isLoginLocked(email: string, ip: string | null): Promise<boolean> {
  return failOpen("login_check", false, () => anyLocked(loginTargets(email, ip)));
}

/** Registra una contraseña incorrecta. Devuelve `true` si con este fallo quedó bloqueado. */
export function recordLoginFailure(email: string, ip: string | null): Promise<boolean> {
  return failOpen("login_failure", false, () => recordAll(loginTargets(email, ip)));
}

/** Un ingreso exitoso limpia los fallos de esa cuenta (los de la IP siguen su curso). */
export function clearLoginFailures(email: string): Promise<void> {
  return failOpen("login_clear", undefined, async () => {
    const { error } = await createAdminClient().rpc("auth_limit_clear", {
      p_scope: "login_email",
      p_key_hash: emailFingerprint(email),
    });
    if (error) throw new Error(error.code ?? "rate_limit_clear_failed");
  });
}

/** ¿Esta IP ya creó demasiadas cuentas? */
export function isSignupLocked(ip: string | null): Promise<boolean> {
  return failOpen("signup_check", false, () => anyLocked(signupTargets(ip)));
}

/** Cada intento de registro cuenta (no hay "fallo" que distinguir sin revelar si el correo existía). */
export function recordSignupAttempt(ip: string | null): Promise<boolean> {
  return failOpen("signup_attempt", false, () => recordAll(signupTargets(ip)));
}
