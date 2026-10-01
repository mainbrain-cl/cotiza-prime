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

/** Crea una cuenta ficticia en auth.users (dominio reservado .test). El trigger crea el perfil. */
export async function createUser(
  client: Client,
  options: { confirmed?: boolean; meta?: Record<string, unknown> } = {},
): Promise<TestUser> {
  const id = randomUUID();
  const email = `u-${id.slice(0, 8)}@ejemplo.test`;
  await client.query(
    `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, aud, role)
     values ($1, $2, case when $3 then now() end, $4::jsonb, 'authenticated', 'authenticated')`,
    [id, email, options.confirmed ?? true, JSON.stringify(options.meta ?? {})],
  );
  return { id, email };
}

/** Pasa a actuar como `authenticated` con ese pase y, opcionalmente, esa cabecera de organización. */
export async function actAs(
  client: Client,
  user: TestUser,
  headers: Record<string, string> = {},
  role: "authenticated" | "postgres" = "authenticated",
): Promise<void> {
  await client.query("reset role");
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: user.id, role: "authenticated" }),
  ]);
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
