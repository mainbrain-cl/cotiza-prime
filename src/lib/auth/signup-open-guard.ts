import "server-only";
import { PRODUCTION_ENV, resolveAppEnv } from "@/lib/env/app-env";
import { serverLog } from "@/lib/log/server-log";

/**
 * La comprobación `signup-open-guard` (H-116, decisión J5). Si en PRODUCCIÓN el registro público de Supabase está ABIERTO
 * (alguien dejó mal un interruptor del panel), NUESTRO formulario de registro se bloquea («El registro no está disponible por
 * ahora») y se deja una alerta en el registro del servidor.
 *
 * Lo que esto NO es: no es una defensa contra el ataque. El atacante no usa nuestro formulario, llama `POST /auth/v1/signup`
 * directo con la llave pública. Lo que de verdad defiende es el registro apagado en Supabase (`npm run check:auth-config`), la
 * pasarela y la base de datos (`complete_account_setup`). Esto solo hace visible el error y evita sumar cuentas nuevas por nuestro
 * formulario mientras se corrige.
 *
 * Cómo funciona: lee `GET {SUPABASE_URL}/auth/v1/settings` (público: solo trae la parte pública de la configuración) y mira
 * `disable_signup`. La lectura se guarda 5 minutos en memoria de cada proceso del servidor; no hay una comprobación en segundo
 * plano: se hace al mostrar o enviar el formulario de registro (la primera vez tras arrancar y luego como mucho cada 5 minutos).
 * Si no se puede leer (red, Supabase caído, respuesta rara) NO se bloquea: sin Supabase el registro tampoco funciona, y bloquear por
 * un fallo de lectura convertiría una caída en otra.
 */

/** Cuánto vale una lectura (5 minutos). */
export const SIGNUP_GUARD_TTL_MS = 5 * 60 * 1000;
/** Cuánto se espera la respuesta de Supabase. */
const READ_TIMEOUT_MS = 3_000;

export type SignupOpenState = "open" | "closed" | "unknown";

type Cached = { readAt: number; state: SignupOpenState };
let cached: Cached | null = null;

/** Solo para pruebas: olvida la lectura guardada. */
export function resetSignupGuardCache(): void {
  cached = null;
}

/** Interpreta la respuesta de `/auth/v1/settings`: solo `disable_signup` booleano cuenta; todo lo demás es «no se sabe». */
export function interpretSettings(body: unknown): SignupOpenState {
  if (typeof body !== "object" || body === null) return "unknown";
  const disabled = (body as Record<string, unknown>).disable_signup;
  if (disabled === true) return "closed";
  if (disabled === false) return "open";
  return "unknown";
}

async function readOnce(fetchImpl: typeof fetch): Promise<SignupOpenState> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !key) return "unknown";
  try {
    const response = await fetchImpl(`${base.replace(/\/+$/, "")}/auth/v1/settings`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return "unknown";
    return interpretSettings(await response.json());
  } catch {
    return "unknown";
  }
}

/**
 * El estado del registro público de Supabase, con la lectura guardada 5 minutos. Alerta (registro del servidor, nivel de
 * error) cada vez que se lee y está abierto.
 */
export async function readSignupOpenState(
  options: { now?: number; fetchImpl?: typeof fetch } = {},
): Promise<SignupOpenState> {
  const now = options.now ?? Date.now();
  if (cached && now - cached.readAt < SIGNUP_GUARD_TTL_MS) return cached.state;
  const state = await readOnce(options.fetchImpl ?? fetch);
  cached = { readAt: now, state };
  if (state === "open") {
    await serverLog("error", "signup_open_in_supabase", { blocked: true });
  }
  return state;
}

/**
 * ¿Hay que bloquear NUESTRO formulario de registro? Solo en producción y solo si Supabase tiene el registro público abierto.
 * En pruebas y en local no se consulta nada (allí lo vigilan `check:auth-config` y la guardia 17e sobre `config.toml`).
 */
export async function isSignupBlockedByOpenSupabase(
  options: { env?: string | undefined; now?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const env = resolveAppEnv("env" in options ? options.env : process.env.NEXT_PUBLIC_APP_ENV);
  if (env !== PRODUCTION_ENV) return false;
  return (await readSignupOpenState(options)) === "open";
}
