// Prueba los "deshacer" de las migraciones contra la base LOCAL:
//   1. deshace la última y la vuelve a aplicar;
//   2. deshace todas en orden inverso y comprueba que no queda nada;
//   3. vuelve a aplicar todas en orden.
// Destruye los datos de la base local (es de pruebas). Se niega a correr contra otra base.
// Uso: npm run test:db:rollbacks   (después de `supabase db reset`)
// Solo pruebas: la aplicación no abre conexiones SQL directas; este script sí, a propósito.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const url =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:56322/postgres";
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) {
  throw new Error("check-rollbacks solo corre contra la base local");
}

const root = path.resolve(import.meta.dirname, "..", "supabase");
const ups = readdirSync(path.join(root, "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const downOf = (up) => path.join(root, "rollbacks", up.replace(/\.sql$/, ".down.sql"));
const read = (file) => readFileSync(file, "utf8");

const client = new pg.Client({ connectionString: url });
await client.connect();

const up = (file) => client.query(read(path.join(root, "migrations", file)));
const down = (file) => client.query(read(downOf(file)));

for (const file of ups) read(downOf(file)); // falla si falta algún deshacer

// Los deshacer de las migraciones 21 a 26 se niegan a correr si hay registros legales (envíos,
// respuestas del cliente, cotizaciones enviadas). Las pruebas anteriores dejan datos ficticios, así que
// aquí se vacían todas las tablas de `public` de la base LOCAL. `replica` apaga las reglas de solo
// agregar (disparadores) solo en esta conexión; nunca se usa fuera de este script de pruebas.
async function wipeLocalData() {
  const { rows } = await client.query(
    `select format('%I.%I', n.nspname, c.relname) as t
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')`,
  );
  if (rows.length === 0) return;
  await client.query("set session_replication_role = replica");
  try {
    await client.query(`truncate ${rows.map((r) => r.t).join(", ")}`);
  } finally {
    await client.query("set session_replication_role = origin");
  }
}
console.log("Vaciar los datos ficticios de la base local");
await wipeLocalData();

// Prueba de la protección: con un registro legal, el deshacer de la 26 se niega y no cambia nada.
async function checkRefusal() {
  const { rows } = await client.query("select count(*)::int as n from public.quote_packages");
  if (rows[0].n !== 0) throw new Error("la base debía quedar vacía");
  await client.query("set session_replication_role = replica");
  try {
    await client.query(`insert into public.quote_packages
      (id, tenant_id, quote_id, send_key, issue_date, valid_until, email_subject, email_body_md,
       customer_snapshot_enc, created_by, quote_revision, approval_rule_id)
      values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), current_date,
              current_date, 's', 'b', 'v1.x.y', gen_random_uuid(), 1, gen_random_uuid())`);
  } finally {
    await client.query("set session_replication_role = origin");
  }
  let refused = false;
  try {
    await down("20261006150000_sprint3_review_fixes.sql");
  } catch (error) {
    refused = /registro legal/.test(String(error.message));
  }
  if (!refused) throw new Error("el deshacer de la 26 debía negarse con datos");
  await wipeLocalData();
}
console.log("Comprobar que el deshacer se niega si hay registros legales");
await checkRefusal();

console.log(`Deshacer y reaplicar la última: ${ups.at(-1)}`);
await down(ups.at(-1));
await up(ups.at(-1));

console.log("Deshacer todas en orden inverso");
for (const file of [...ups].reverse()) {
  await down(file);
  console.log(`  deshecha ${file}`);
}

const { rows: leftovers } = await client.query(`
  select 'table:' || c.relname as what from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')
  union all select 'schema:app' from pg_namespace where nspname = 'app'
  union all select 'function:' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  union all select 'trigger:auth.users' from pg_trigger t
    where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal`);
if (leftovers.length > 0) {
  throw new Error(
    `Quedaron objetos tras deshacer todo: ${leftovers.map((r) => r.what).join(", ")}`,
  );
}

console.log("Reaplicar todas en orden");
for (const file of ups) {
  await up(file);
  console.log(`  aplicada ${file}`);
}

await client.end();
console.log("OK: los deshacer funcionan");
