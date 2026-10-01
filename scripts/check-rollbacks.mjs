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
