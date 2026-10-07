import "server-only";
import { isIP } from "node:net";
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

/**
 * Registros de "acceso denegado a una organización" que se escriben por persona y por ventana.
 * Pasado el tope se sigue respondiendo 404, pero ya no se escribe en la auditoría: quien prueba
 * direcciones ajenas no puede llenarla.
 */
export const TENANT_DENIED_MAX_LOGGED_PER_WINDOW = 20;
export const TENANT_DENIED_WINDOW_SECONDS = 15 * SECONDS_PER_MINUTE;

/** Grupo único de los intentos de registro cuyo origen no se pudo determinar (solo producción). */
const UNKNOWN_IP_GROUP = "desconocida";
/** Una IPv6 se agrupa por bloque /64: los primeros 4 de sus 8 grupos. */
const IPV6_GROUPED_HEXTETS = 4;
const IPV6_TOTAL_HEXTETS = 8;

/** Mensaje único: no revela si el correo existe ni cuál de los límites se alcanzó. */
export const RATE_LIMITED_MESSAGE =
  "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.";

/** Pedidos de restablecer contraseña permitidos por cuenta y por IP dentro de la ventana (H-003). */
export const RESET_MAX_REQUESTS_PER_ACCOUNT = 3;
export const RESET_MAX_REQUESTS_PER_IP = 10;
export const RESET_WINDOW_SECONDS = 15 * SECONDS_PER_MINUTE;
export const RESET_LOCK_SECONDS = 15 * SECONDS_PER_MINUTE;

/**
 * PDF de cotizaciones (H-028): armar uno es costoso (hasta ~35 s y cientos de MB con 200 líneas), así
 * que se limitan los PDF que realmente se arman (los que salen de la caché no cuentan), por persona y
 * por organización. Los primeros N pasan; el siguiente queda bloqueado hasta que termine el bloqueo.
 */
export const PDF_MAX_PER_USER_PER_WINDOW = 10;
export const PDF_MAX_PER_TENANT_PER_WINDOW = 30;
export const PDF_WINDOW_SECONDS = SECONDS_PER_MINUTE;
export const PDF_LOCK_SECONDS = SECONDS_PER_MINUTE;

/**
 * Envíos y reenvíos de cotizaciones por correo (H-029): cada intento cuenta por persona, también los
 * que repiten la misma clave de envío. Pasado el tope, el siguiente queda bloqueado un rato.
 */
export const SEND_MAX_PER_USER_PER_WINDOW = 15;
export const SEND_WINDOW_SECONDS = 10 * SECONDS_PER_MINUTE;
export const SEND_LOCK_SECONDS = 10 * SECONDS_PER_MINUTE;

/**
 * Enlace del cliente (H-030): lecturas permitidas por minuto desde una misma IP y sobre un mismo
 * enlace. El pedido número N+1 es el que bloquea. Siempre con huellas: nunca la IP ni el token.
 */
export const SHARE_MAX_READS_PER_IP_PER_WINDOW = 60;
export const SHARE_MAX_READS_PER_LINK_PER_WINDOW = 30;
export const SHARE_WINDOW_SECONDS = SECONDS_PER_MINUTE;
export const SHARE_LOCK_SECONDS = SECONDS_PER_MINUTE;

/**
 * Respuestas del cliente a una cotización (H-031): aceptar o rechazar es poco frecuente, así que el
 * tope por IP es bajo. El intento número N+1 es el que bloquea.
 */
export const SHARE_RESPOND_MAX_PER_IP_PER_WINDOW = 10;
export const SHARE_RESPOND_WINDOW_SECONDS = 60 * SECONDS_PER_MINUTE;
export const SHARE_RESPOND_LOCK_SECONDS = 60 * SECONDS_PER_MINUTE;

/**
 * Formulario público (H-087): lo llena cualquiera sin cuenta, así que se limita por IP antes de tocar la
 * base. Envíos por IP en 10 minutos y en el día (cada intento cuenta, también los que fallan) y lecturas
 * de la página por IP por minuto. El intento número N+1 es el que bloquea. Siempre con huellas.
 */
export const INTAKE_SUBMIT_MAX_PER_IP_PER_WINDOW = 5;
export const INTAKE_SUBMIT_WINDOW_SECONDS = 10 * SECONDS_PER_MINUTE;
export const INTAKE_SUBMIT_LOCK_SECONDS = 10 * SECONDS_PER_MINUTE;
export const INTAKE_SUBMIT_MAX_PER_IP_PER_DAY = 20;
export const INTAKE_SUBMIT_DAY_SECONDS = 24 * 60 * SECONDS_PER_MINUTE;
export const INTAKE_READ_MAX_PER_IP_PER_WINDOW = 60;
export const INTAKE_READ_WINDOW_SECONDS = SECONDS_PER_MINUTE;
export const INTAKE_READ_LOCK_SECONDS = SECONDS_PER_MINUTE;

export type RateLimitScope =
  | "login_email"
  | "login_ip"
  | "signup_ip"
  | "tenant_denied_user"
  | "reset_email"
  | "reset_ip"
  | "pdf_user"
  | "pdf_tenant"
  | "quote_send_user"
  | "share_ip"
  | "share_token"
  | "share_respond_ip"
  | "intake_read_ip"
  | "intake_submit_ip"
  | "intake_submit_ip_day";

/**
 * La tabla `auth_rate_limits` solo admite ciertos valores en su columna `scope`. Los pedidos de
 * restablecer contraseña reutilizan dos de ellos; no se mezclan con los de ingreso o registro
 * porque la huella (`key_hash`) se calcula con un nombre de campo distinto.
 * TODO: una migración puede darles su propio valor en la columna.
 */
const STORAGE_SCOPE: Record<RateLimitScope, string> = {
  login_email: "login_email",
  login_ip: "login_ip",
  signup_ip: "signup_ip",
  tenant_denied_user: "tenant_denied_user",
  reset_email: "login_email",
  reset_ip: "signup_ip",
  pdf_user: "pdf_user",
  pdf_tenant: "pdf_tenant",
  quote_send_user: "quote_send_user",
  share_ip: "share_ip",
  share_token: "share_token",
  share_respond_ip: "share_respond_ip",
  intake_read_ip: "intake_read_ip",
  intake_submit_ip: "intake_submit_ip",
  intake_submit_ip_day: "intake_submit_ip_day",
};

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
  // El intento número N+1 es el que bloquea: los primeros N sí se registran.
  tenant_denied_user: {
    maxFailures: TENANT_DENIED_MAX_LOGGED_PER_WINDOW + 1,
    windowSeconds: TENANT_DENIED_WINDOW_SECONDS,
    lockSeconds: TENANT_DENIED_WINDOW_SECONDS,
  },
  // Cada pedido cuenta; el siguiente al tope queda bloqueado.
  reset_email: {
    maxFailures: RESET_MAX_REQUESTS_PER_ACCOUNT,
    windowSeconds: RESET_WINDOW_SECONDS,
    lockSeconds: RESET_LOCK_SECONDS,
  },
  reset_ip: {
    maxFailures: RESET_MAX_REQUESTS_PER_IP,
    windowSeconds: RESET_WINDOW_SECONDS,
    lockSeconds: RESET_LOCK_SECONDS,
  },
  // El pedido número N+1 es el que bloquea: los primeros N pasan.
  pdf_user: {
    maxFailures: PDF_MAX_PER_USER_PER_WINDOW + 1,
    windowSeconds: PDF_WINDOW_SECONDS,
    lockSeconds: PDF_LOCK_SECONDS,
  },
  pdf_tenant: {
    maxFailures: PDF_MAX_PER_TENANT_PER_WINDOW + 1,
    windowSeconds: PDF_WINDOW_SECONDS,
    lockSeconds: PDF_LOCK_SECONDS,
  },
  quote_send_user: {
    maxFailures: SEND_MAX_PER_USER_PER_WINDOW + 1,
    windowSeconds: SEND_WINDOW_SECONDS,
    lockSeconds: SEND_LOCK_SECONDS,
  },
  share_ip: {
    maxFailures: SHARE_MAX_READS_PER_IP_PER_WINDOW + 1,
    windowSeconds: SHARE_WINDOW_SECONDS,
    lockSeconds: SHARE_LOCK_SECONDS,
  },
  share_token: {
    maxFailures: SHARE_MAX_READS_PER_LINK_PER_WINDOW + 1,
    windowSeconds: SHARE_WINDOW_SECONDS,
    lockSeconds: SHARE_LOCK_SECONDS,
  },
  share_respond_ip: {
    maxFailures: SHARE_RESPOND_MAX_PER_IP_PER_WINDOW + 1,
    windowSeconds: SHARE_RESPOND_WINDOW_SECONDS,
    lockSeconds: SHARE_RESPOND_LOCK_SECONDS,
  },
  intake_read_ip: {
    maxFailures: INTAKE_READ_MAX_PER_IP_PER_WINDOW + 1,
    windowSeconds: INTAKE_READ_WINDOW_SECONDS,
    lockSeconds: INTAKE_READ_LOCK_SECONDS,
  },
  intake_submit_ip: {
    maxFailures: INTAKE_SUBMIT_MAX_PER_IP_PER_WINDOW + 1,
    windowSeconds: INTAKE_SUBMIT_WINDOW_SECONDS,
    lockSeconds: INTAKE_SUBMIT_LOCK_SECONDS,
  },
  intake_submit_ip_day: {
    maxFailures: INTAKE_SUBMIT_MAX_PER_IP_PER_DAY + 1,
    windowSeconds: INTAKE_SUBMIT_DAY_SECONDS,
    lockSeconds: INTAKE_SUBMIT_DAY_SECONDS,
  },
};

/**
 * Clave de agrupación de una IP. Una IPv4 cuenta tal cual; una IPv6 se agrupa por bloque /64,
 * porque un solo cliente controla las 2^64 direcciones de su bloque y, sin agrupar, cambiaría de
 * dirección en cada intento para esquivar el límite. Una IPv4 escrita como IPv6 (::ffff:a.b.c.d)
 * cuenta como IPv4.
 *
 * ATENCIÓN: esto supone que la IP que llega es la real del cliente (la reescribe Vercel en el
 * borde). Si algún día hay un proxy o una red de distribución delante de Vercel, `x-forwarded-for`
 * pasaría a traer la IP de ese intermediario y todos los clientes caerían en el mismo grupo:
 * habría que revisar de dónde se lee la IP (`src/lib/http/request-context.ts`).
 */
export function ipLimitKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const [head, tail] = lower.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = tail === undefined ? 0 : IPV6_TOTAL_HEXTETS - headParts.length - tailParts.length;
  const hextets = [...headParts, ...Array<string>(Math.max(missing, 0)).fill("0"), ...tailParts];
  const block = hextets.slice(0, IPV6_GROUPED_HEXTETS).map((h) => h.padStart(4, "0"));
  return `${block.join(":")}::/64`;
}

/** Huella de un correo, para el contador y para la auditoría (nunca el correo en claro). */
export function emailFingerprint(email: string): string {
  return searchHash("login_email", PLATFORM_TENANT_ID, normalizeEmail(email));
}

function ipFingerprint(scope: "login_ip" | "signup_ip" | "reset_ip", ip: string): string {
  return searchHash(scope, PLATFORM_TENANT_ID, ipLimitKey(ip));
}

type Target = { scope: RateLimitScope; keyHash: string };

function loginTargets(email: string, ip: string | null): Target[] {
  const targets: Target[] = [{ scope: "login_email", keyHash: emailFingerprint(email) }];
  // Sin IP conocida no se limita por IP (un solo grupo "desconocido" bloquearía a todos); sigue
  // vigente el límite por cuenta.
  if (ip) targets.push({ scope: "login_ip", keyHash: ipFingerprint("login_ip", ip) });
  return targets;
}

function resetTargets(email: string, ip: string | null): Target[] {
  const targets: Target[] = [
    {
      scope: "reset_email",
      keyHash: searchHash("reset_email", PLATFORM_TENANT_ID, normalizeEmail(email)),
    },
  ];
  if (ip) targets.push({ scope: "reset_ip", keyHash: ipFingerprint("reset_ip", ip) });
  return targets;
}

function signupTargets(ip: string | null): Target[] {
  if (ip) return [{ scope: "signup_ip", keyHash: ipFingerprint("signup_ip", ip) }];
  // En producción la IP siempre debería venir. Si falta, el registro no queda sin límite: todos los
  // intentos sin origen cuentan juntos en el grupo "desconocida" (se prefiere frenar de más a dejar
  // pasar un registro masivo). En desarrollo y pruebas no se limita sin IP.
  if (process.env.NODE_ENV === "production") {
    return [{ scope: "signup_ip", keyHash: ipFingerprint("signup_ip", UNKNOWN_IP_GROUP) }];
  }
  return [];
}

async function anyLocked(targets: Target[]): Promise<boolean> {
  const admin = createAdminClient();
  for (const target of targets) {
    const { data, error } = await admin.rpc("auth_limit_locked_until", {
      p_scope: STORAGE_SCOPE[target.scope],
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
      p_scope: STORAGE_SCOPE[target.scope],
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

/**
 * ¿Corresponde escribir en la auditoría este acceso denegado a una organización? Cuenta el intento
 * de esta persona y responde `false` pasado el tope por ventana. Si el contador falla, se registra
 * igual: perder un registro de seguridad es peor que escribir uno de más.
 */
export async function shouldLogTenantDenied(userId: string): Promise<boolean> {
  const target: Target = {
    scope: "tenant_denied_user",
    keyHash: searchHash("tenant_denied_user", PLATFORM_TENANT_ID, userId),
  };
  const overTheCap = await failOpen("tenant_denied_count", false, () => recordAll([target]));
  return !overTheCap;
}

/**
 * ¿Esta persona puede enviar o reenviar otra cotización ahora? Cuenta el intento y responde `false`
 * si ya llegó al tope (H-029). Si el contador falla, se deja pasar y se avisa en el log.
 */
export async function consumeSendQuota(userId: string, tenantId: string): Promise<boolean> {
  const target: Target = {
    scope: "quote_send_user",
    keyHash: searchHash("quote_send_user", tenantId, userId),
  };
  return !(await failOpen("quote_send_quota", false, () => recordAll([target])));
}

/** ¿Esta cuenta o esta IP ya pidió demasiados restablecimientos? */
export function isResetLocked(email: string, ip: string | null): Promise<boolean> {
  return failOpen("reset_check", false, () => anyLocked(resetTargets(email, ip)));
}

/** Cada pedido cuenta, exista o no la cuenta: así el límite tampoco revela nada. */
export function recordResetRequest(email: string, ip: string | null): Promise<boolean> {
  return failOpen("reset_request", false, () => recordAll(resetTargets(email, ip)));
}

/**
 * ¿Esta persona, en esta organización, puede armar otro PDF ahora? Cuenta el pedido contra los dos
 * límites (persona y organización) y responde `false` si alguno ya está bloqueado. Si el contador
 * falla, se deja pasar y se avisa en el log (igual que el resto del limitador).
 */
export async function consumePdfQuota(userId: string, tenantId: string): Promise<boolean> {
  const user: Target = {
    scope: "pdf_user",
    keyHash: searchHash("pdf_user", PLATFORM_TENANT_ID, userId),
  };
  const tenant: Target = {
    scope: "pdf_tenant",
    keyHash: searchHash("pdf_tenant", PLATFORM_TENANT_ID, tenantId),
  };
  // Primero la persona: quien ya está bloqueado no gasta el cupo de la organización.
  if (await failOpen("pdf_quota_user", false, () => recordAll([user]))) return false;
  return !(await failOpen("pdf_quota_tenant", false, () => recordAll([tenant])));
}

/**
 * Clave de IP de los límites del enlace del cliente. Sin IP conocida, en producción todo lo que no
 * trae origen cuenta junto en el grupo "desconocida" (como el registro de cuentas): se prefiere
 * frenar de más a dejar intentos sin tope. En desarrollo y pruebas sin IP no se limita por IP.
 */
function shareIpKey(ip: string | null): string | null {
  if (ip) return ipLimitKey(ip);
  return process.env.NODE_ENV === "production" ? UNKNOWN_IP_GROUP : null;
}

/**
 * ¿Puede esta lectura del enlace del cliente seguir (H-030)? Cuenta el pedido contra dos límites:
 * la IP (si se conoce) y el enlace, y responde `false` si alguno ya está bloqueado. Las claves son
 * huellas: de la IP agrupada y del sello (sha256) del enlace, nunca el token ni la IP en claro. Si el
 * contador falla, se deja pasar y se avisa en el log (igual que el resto del limitador).
 */
export async function consumeShareQuota(ip: string | null, tokenSha256: string): Promise<boolean> {
  const ipKey = shareIpKey(ip);
  if (ipKey) {
    const byIp: Target = {
      scope: "share_ip",
      keyHash: searchHash("share_ip", PLATFORM_TENANT_ID, ipKey),
    };
    if (await failOpen("share_quota_ip", false, () => recordAll([byIp]))) return false;
  }
  const byLink: Target = {
    scope: "share_token",
    keyHash: searchHash("share_token", PLATFORM_TENANT_ID, tokenSha256),
  };
  return !(await failOpen("share_quota_link", false, () => recordAll([byLink])));
}

/**
 * ¿Esta IP puede responder otra cotización ahora (H-031)? Cuenta el intento y responde `false` si ya
 * llegó al tope por hora. La clave es una huella de la IP agrupada, nunca la IP en claro. Sin IP
 * conocida, en producción cuenta en el grupo "desconocida"; en desarrollo y pruebas no se limita. Si el contador
 * falla, se deja pasar y se avisa en el log.
 */
export async function consumeShareRespondQuota(ip: string | null): Promise<boolean> {
  const ipKey = shareIpKey(ip);
  if (!ipKey) return true;
  const target: Target = {
    scope: "share_respond_ip",
    keyHash: searchHash("share_respond_ip", PLATFORM_TENANT_ID, ipKey),
  };
  return !(await failOpen("share_respond_quota_ip", false, () => recordAll([target])));
}

/**
 * ¿Puede esta IP leer la página del formulario público (H-087)? Cuenta la lectura y responde `false` al
 * pasar el tope por minuto. La clave es una huella de la IP agrupada, nunca la IP en claro. Sin IP
 * conocida, en producción cuenta en el grupo "desconocida"; en desarrollo y pruebas no se limita. Si el
 * contador falla, se deja pasar y se avisa en el log.
 */
export async function consumeIntakeReadQuota(ip: string | null): Promise<boolean> {
  const ipKey = shareIpKey(ip);
  if (!ipKey) return true;
  const target: Target = {
    scope: "intake_read_ip",
    keyHash: searchHash("intake_read_ip", PLATFORM_TENANT_ID, ipKey),
  };
  return !(await failOpen("intake_read_quota_ip", false, () => recordAll([target])));
}

/** Resultado del límite de envíos: pasa, queda bloqueada AHORA, o ya estaba bloqueada de antes. */
export type IntakeSubmitQuota = "allowed" | "blocked_now" | "blocked_repeat";

/**
 * ¿Puede esta IP enviar otra solicitud por un formulario público (H-087)? Cada intento cuenta (también
 * los que fallan), primero contra el tope de 10 minutos y, si pasa, contra el del día. Distingue la IP que
 * RECIÉN queda bloqueada (`blocked_now`, la que se anota como bloqueo del formulario) de la que ya estaba
 * bloqueada (`blocked_repeat`, que no suma ni gasta más cupo): así quien insiste no infla los contadores
 * del formulario. Huellas de la IP agrupada, nunca la IP en claro. Si el contador falla, se deja pasar y se
 * avisa en el log: el tope diario de solicitudes vive dentro de la base, no aquí.
 */
export async function consumeIntakeSubmitQuota(ip: string | null): Promise<IntakeSubmitQuota> {
  const ipKey = shareIpKey(ip);
  if (!ipKey) return "allowed";
  const targets: { target: Target; operation: string }[] = [
    {
      target: {
        scope: "intake_submit_ip",
        keyHash: searchHash("intake_submit_ip", PLATFORM_TENANT_ID, ipKey),
      },
      operation: "intake_submit_quota_window",
    },
    {
      target: {
        scope: "intake_submit_ip_day",
        keyHash: searchHash("intake_submit_ip_day", PLATFORM_TENANT_ID, ipKey),
      },
      operation: "intake_submit_quota_day",
    },
  ];
  for (const { target, operation } of targets) {
    // Si ya estaba bloqueada, no se vuelve a contar: no es un bloqueo nuevo.
    if (await failOpen(`${operation}_check`, false, () => anyLocked([target]))) {
      return "blocked_repeat";
    }
    if (await failOpen(operation, false, () => recordAll([target]))) return "blocked_now";
  }
  return "allowed";
}
