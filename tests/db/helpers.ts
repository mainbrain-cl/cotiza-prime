// Ayudas para las pruebas de la base de datos.
//
// Estas pruebas se conectan DIRECTO a Postgres con `pg` para leer el catálogo y simular
// sesiones. Es solo para pruebas: la aplicación NO abre conexiones SQL directas, todo pasa por
// el cliente de Supabase (docs/arquitectura/modelo-datos.md §2.1).
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_URL = "postgresql://postgres:postgres@127.0.0.1:56322/postgres";

/** Se niega a conectarse a cualquier base que no sea la local (nunca producción). */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Las pruebas de base de datos solo corren contra una base local, no contra ${host}`,
    );
  }
  return url;
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  return client;
}

/** Corre `fn` dentro de una transacción que siempre se deshace: no deja residuos. */
export async function withTx<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

/** Ejecuta `sql` esperando un error; devuelve el error. Usa un savepoint para no abortar la transacción. */
export async function expectSqlError(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<{ code?: string; message: string }> {
  await client.query("savepoint expect_error");
  try {
    await client.query(sql, params);
  } catch (error) {
    await client.query("rollback to savepoint expect_error");
    const e = error as { code?: string; message: string };
    return { code: e.code, message: e.message };
  }
  await client.query("release savepoint expect_error");
  throw new Error(`Se esperaba un error y la consulta tuvo éxito: ${sql}`);
}

export interface TestUser {
  id: string;
  email: string;
}

/**
 * Crea una cuenta ficticia en auth.users (dominio reservado .test). El trigger crea el perfil y anota `signup_email`.
 * H-116: por defecto la cuenta queda TERMINADA (`account_ready_at` puesta), como las de la semilla y las de uso normal; con
 * `ready: false` queda SIN terminar (solo las pruebas de «cuenta sin terminar» la piden). `email` fija el correo de la cuenta.
 */
export async function createUser(
  client: Client,
  options: {
    confirmed?: boolean;
    meta?: Record<string, unknown>;
    ready?: boolean;
    email?: string;
  } = {},
): Promise<TestUser> {
  const id = randomUUID();
  const email = options.email ?? `u-${id.slice(0, 8)}@ejemplo.test`;
  await client.query(
    `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, aud, role)
     values ($1, $2, case when $3 then now() end, $4::jsonb, 'authenticated', 'authenticated')`,
    [id, email, options.confirmed ?? true, JSON.stringify(options.meta ?? {})],
  );
  if (options.ready ?? true) await markAccountReady(client, id);
  return { id, email };
}

/**
 * Pone `account_ready_at` (cuenta terminada) como postgres. Si la migración de H-116 está deshecha (la columna no existe: pruebas
 * de migraciones anteriores), no hace nada.
 */
export async function markAccountReady(client: Client, userId: string): Promise<void> {
  const { rowCount } = await client.query(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = 'account_ready_at'`,
  );
  if (rowCount === 0) return;
  await client.query(
    "update public.profiles set account_ready_at = now() where user_id = $1 and account_ready_at is null",
    [userId],
  );
}

/**
 * Cambia el correo de una cuenta POR SQL DIRECTO, como lo haría soporte: con el interruptor `app.allow_email_change` (solo vale en esta
 * transacción; el disparador de H-116 prohíbe el cambio sin él) y, para que la cuenta siga contando como «creada con ese correo»,
 * también su correo de alta (`signup_email`). Solo pruebas que comparan el correo de la cuenta con el de una invitación.
 */
export async function setAccountEmail(
  client: Client,
  userId: string,
  email: string,
  options: { keepSignupEmail?: boolean } = {},
): Promise<void> {
  await client.query("reset role");
  await client.query("select set_config('app.allow_email_change', 'on', true)");
  await client.query("update auth.users set email = $2 where id = $1", [userId, email]);
  await client.query("select set_config('app.allow_email_change', 'off', true)");
  if (options.keepSignupEmail) return;
  const { rowCount } = await client.query(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = 'signup_email'`,
  );
  if (rowCount === 0) return;
  await client.query("update public.profiles set signup_email = lower($2) where user_id = $1", [
    userId,
    email,
  ]);
}

/**
 * H-116: la sesión «de verdad» que el pase debe nombrar (`session_id`): PostgREST solo revisa firma y vencimiento, pero la base
 * comprueba que la sesión siga en `auth.sessions` (`app.session_alive()`). Devuelve la sesión que ya tenga la cuenta o crea una;
 * `null` si la cuenta no existe. Tiene que correr como postgres (`actAs` ya hizo `reset role`).
 */
export async function ensureSession(client: Client, userId: string): Promise<string | null> {
  const found = await client.query<{ id: string }>(
    "select id from auth.sessions where user_id = $1 order by created_at limit 1",
    [userId],
  );
  if (found.rows[0]) return found.rows[0].id;
  const created = await client.query<{ id: string }>(
    `insert into auth.sessions (id, user_id, created_at, updated_at, aal)
     select gen_random_uuid(), u.id, now(), now(), 'aal1' from auth.users u where u.id = $1
     returning id`,
    [userId],
  );
  return created.rows[0]?.id ?? null;
}

/** Lo que el pase de la persona dice además de quién es (todo opcional). */
export interface PassOptions {
  /** Cómo se abrió la sesión (`amr`). Sin valor, el pase no lo trae. */
  amr?: unknown;
  /** Nivel de seguridad del pase (`aal1` o `aal2`). Sin valor, el pase no lo trae. */
  aal?: string;
  /** Sesión que nombra el pase: la de la cuenta (`"live"`, por defecto: se crea si falta), ninguna (`"none"`) o un id concreto. */
  session?: "live" | "none" | string;
}

/**
 * Los datos del pase de una persona como los entrega PostgREST: `sub`, `role` y, desde H-116, `session_id` de una sesión REAL en
 * `auth.sessions` (la crea si falta). Corre como postgres: `reset role` antes.
 */
export async function passClaims(
  client: Client,
  userId: string,
  options: PassOptions = {},
): Promise<Record<string, unknown>> {
  await client.query("reset role");
  const wanted = options.session ?? "live";
  const sessionId =
    wanted === "none" ? null : wanted === "live" ? await ensureSession(client, userId) : wanted;
  return {
    sub: userId,
    role: "authenticated",
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(options.aal ? { aal: options.aal } : {}),
    ...(options.amr === undefined ? {} : { amr: options.amr }),
  };
}

/** Pasa a actuar como `authenticated` con ese pase y, opcionalmente, esa cabecera de organización. */
export async function actAs(
  client: Client,
  user: TestUser,
  headers: Record<string, string> = {},
  role: "authenticated" | "postgres" = "authenticated",
  pass: PassOptions = {},
): Promise<void> {
  const claims = await passClaims(client, user.id, pass);
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user.id]);
  await client.query(`select set_config('request.headers', $1, true)`, [JSON.stringify(headers)]);
  if (role === "authenticated") {
    await client.query("set local role authenticated");
  }
}

export async function actAsAnon(client: Client): Promise<void> {
  await client.query("reset role");
  await client.query(`select set_config('request.jwt.claims', '', true)`);
  await client.query(`select set_config('request.jwt.claim.sub', '', true)`);
  await client.query(`select set_config('request.headers', '{}', true)`);
  await client.query("set local role anon");
}

export async function actAsPostgres(client: Client): Promise<void> {
  await client.query("reset role");
}

export const TENANT_HEADER = "x-cp-tenant-id";

/** Crea una organización con `create_tenant` actuando como la persona. Devuelve su tenant_id. */
export async function createTenantAs(
  client: Client,
  user: TestUser,
  rut = "76086428-5",
  name = "Negocio Ficticio",
): Promise<string> {
  await actAs(client, user);
  const result = await client.query<{ id: string }>(
    `select public.create_tenant($1, $2, 'services') as id`,
    [name, rut],
  );
  await actAsPostgres(client);
  return result.rows[0].id;
}
