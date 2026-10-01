// Ayudas para las pruebas que hablan con la Supabase LOCAL de verdad (PostgREST, GoTrue, GraphQL).
// Solo pruebas: se niegan a apuntar a otra cosa que no sea la máquina local.
//
// Aquí se centralizan los nombres de las variables (la CLI entrega API_URL, PUBLISHABLE_KEY y
// SECRET_KEY; el `.env.example` usa otros), para que ningún archivo de prueba los lea por su cuenta.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:56322/postgres";
// Los comandos npm corren siempre desde la raíz del repositorio (Vitest y Playwright).
const REPO_ROOT = process.cwd();

export const TEST_PASSWORD = "contrasena-ficticia-123"; // mínimo de 10 caracteres (config.toml)
/** Renueva el pase si le quedan menos de estos segundos. */
const TOKEN_MIN_REMAINING_SECONDS = 60;

export interface LocalEnv {
  apiUrl: string;
  publishableKey: string;
  secretKey: string;
  dbUrl: string;
}

/**
 * Carga `.env.local` si existe (solo para que el proceso de pruebas vea las claves de cifrado y la
 * dirección de Supabase que usa la aplicación). Lo ya definido en el entorno manda.
 */
export function loadLocalEnvFile(): void {
  const file = path.join(REPO_ROOT, ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
}

let cachedEnv: LocalEnv | undefined;

/** Dirección y llaves de la Supabase local. Variables SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY o, si faltan, `supabase status`. */
export function localEnv(): LocalEnv {
  if (cachedEnv) return cachedEnv;
  const dbUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_DB_URL;
  let apiUrl = process.env.SUPABASE_URL;
  let publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  let secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!apiUrl || !publishableKey || !secretKey) {
    const out = execSync("npx supabase status -o json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      cwd: REPO_ROOT,
    });
    const json = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string>;
    apiUrl = json.API_URL;
    publishableKey = json.PUBLISHABLE_KEY;
    secretKey = json.SECRET_KEY;
  }
  for (const url of [apiUrl, dbUrl]) {
    const host = new URL(url).hostname;
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error(
        `Las pruebas de aislamiento solo corren contra Supabase local, no contra ${host}`,
      );
    }
  }
  cachedEnv = { apiUrl, publishableKey, secretKey, dbUrl };
  return cachedEnv;
}

/**
 * Variables que la aplicación (Next.js) necesita para hablar con la Supabase local. Si el entorno ya
 * las trae (`.env.local` o CI), se respetan; si no, salen de `supabase status`.
 * Las usa la configuración de Playwright para levantar el servidor de la prueba.
 */
export function appSupabaseEnv(): Record<string, string> {
  const given = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  if (
    given.NEXT_PUBLIC_SUPABASE_URL &&
    given.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    given.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return given as Record<string, string>;
  }
  const out = execSync("npx supabase status -o json", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    cwd: REPO_ROOT,
  });
  const json = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string>;
  return {
    NEXT_PUBLIC_SUPABASE_URL: given.NEXT_PUBLIC_SUPABASE_URL ?? json.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: given.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? json.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: given.SUPABASE_SERVICE_ROLE_KEY ?? json.SERVICE_ROLE_KEY,
  };
}

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

async function toResult(res: Response): Promise<HttpResult> {
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** Cabeceras extra tal cual (permite duplicadas con coma, mayúsculas, etc.). */
export type ExtraHeaders = Record<string, string>;

/** Pase de sesión real. `null` = anónimo (solo la llave pública). */
export type Token = string | null;

function baseHeaders(token: Token): ExtraHeaders {
  const { publishableKey } = localEnv();
  return {
    apikey: publishableKey,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** Pedido directo a PostgREST (`fetch`, no `supabase-js`) para controlar cada cabecera. */
export async function rest(
  token: Token,
  pathAndQuery: string,
  options: { method?: string; headers?: ExtraHeaders; body?: unknown } = {},
): Promise<HttpResult> {
  const { apiUrl } = localEnv();
  const res = await fetch(`${apiUrl}/rest/v1/${pathAndQuery}`, {
    method: options.method ?? "GET",
    headers: {
      ...baseHeaders(token),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return toResult(res);
}

export function rpc(
  token: Token,
  name: string,
  args: object = {},
  headers: ExtraHeaders = {},
): Promise<HttpResult> {
  return rest(token, `rpc/${name}`, { method: "POST", body: args, headers });
}

export async function graphql(
  token: Token,
  query: string,
  headers: ExtraHeaders = {},
): Promise<HttpResult> {
  const { apiUrl } = localEnv();
  const res = await fetch(`${apiUrl}/graphql/v1`, {
    method: "POST",
    headers: { ...baseHeaders(token), "content-type": "application/json", ...headers },
    body: JSON.stringify({ query }),
  });
  return toResult(res);
}

/** Crea una cuenta confirmada con la llave maestra (solo para montar la fixture). */
export async function adminCreateUser(
  email: string,
  userMetadata: Record<string, unknown> = {},
): Promise<string> {
  const { apiUrl, secretKey } = localEnv();
  const res = await fetch(`${apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: secretKey,
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: userMetadata,
    }),
  });
  if (res.status !== 200) throw new Error(`No se pudo crear la cuenta de prueba (${res.status})`);
  return ((await res.json()) as { id: string }).id;
}

export interface Session {
  accessToken: string;
  /** Segundos desde 1970 en que vence el pase. */
  expiresAt: number;
  userId: string;
}

/** Inicio de sesión real con correo y contraseña. */
export async function signIn(email: string): Promise<Session> {
  const { apiUrl, publishableKey } = localEnv();
  const res = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`No se pudo iniciar sesión de prueba (${res.status})`);
  const body = (await res.json()) as {
    access_token: string;
    expires_at: number;
    user: { id: string };
  };
  return { accessToken: body.access_token, expiresAt: body.expires_at, userId: body.user.id };
}

/** Devuelve un pase vigente: el mismo si le queda tiempo, o uno nuevo iniciando sesión otra vez. */
export async function freshToken(
  email: string,
  current: Session,
): Promise<{ session: Session; token: string }> {
  const remaining = current.expiresAt - Math.floor(Date.now() / 1000);
  if (remaining > TOKEN_MIN_REMAINING_SECONDS) {
    return { session: current, token: current.accessToken };
  }
  const session = await signIn(email);
  return { session, token: session.accessToken };
}
