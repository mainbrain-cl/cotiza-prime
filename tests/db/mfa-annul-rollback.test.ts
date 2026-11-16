// 🟢 PRUEBAS · Supabase local, datos ficticios.
// H-118b · migración 20261113110000_mfa_annul y su deshacer: lock_timeout y su verificador, `security definer` con `search_path`
// vacío, que el deshacer quita las cuatro funciones sin tocar tablas, que se puede volver a aplicar y que se NIEGA a correr
// (sin cambiar nada) si una función ya no es la de la migración, si otra función las nombra o si hay una anulación en curso.
// Se ejecutan los archivos reales dentro de una transacción que se deshace.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, createUser, expectSqlError, withTx } from "./helpers";
import { functionBodyIn } from "./migration-files";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const NAME = "20261113110000_mfa_annul";
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const code = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

const FUNCTIONS = [
  { name: "public.mfa_annul_claim", signature: "public.mfa_annul_claim(text)" },
  { name: "public.mfa_annul_complete", signature: "public.mfa_annul_complete(uuid)" },
  { name: "public.mfa_annul_release", signature: "public.mfa_annul_release(uuid)" },
  { name: "public.mfa_revoke_sessions", signature: "public.mfa_revoke_sessions(uuid)" },
] as const;

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

const exists = async (signature: string) =>
  (await db.query<{ ok: boolean }>("select to_regprocedure($1) is not null as ok", [signature]))
    .rows[0].ok;

describe("la migración mfa_annul y su deshacer", () => {
  it("MB1 · los dos archivos empiezan con `lock_timeout` de 3 s y su verificador; todo `security definer` fija `search_path` vacío; la migración define las cuatro funciones y ninguna tabla", () => {
    for (const sql of [up, down]) {
      const [first, ...rest] = code(sql).split(";");
      expect(first.replace(/\s+/g, " ").trim()).toBe("set local lock_timeout = '3s'");
      expect(rest.join(";").trimStart()).toMatch(
        /^do \$\$ begin\s+if current_setting\('lock_timeout'\) <> '3s' then\s+raise exception [\s\S]*?;\s+end if;/i,
      );
      const count = (code(sql).match(/security definer/g) ?? []).length;
      expect((code(sql).match(/security definer set search_path = ''/g) ?? []).length).toBe(count);
    }
    const defined = [...code(up).matchAll(/create (?:or replace )?function ([a-z_.]+)\(/gi)].map(
      (m) => m[1],
    );
    expect(defined.sort()).toEqual(FUNCTIONS.map((f) => f.name).sort());
    expect(code(up)).not.toMatch(/create table|alter table/i);
    expect(code(down)).not.toMatch(/drop table|alter table|truncate/i);
  });

  it("MB2 · los md5 que exige el deshacer son los de los cuerpos de la migración y coinciden con la base", async () => {
    for (const fn of FUNCTIONS) {
      const body = functionBodyIn(up, fn.name);
      expect(code(down)).toContain(`md5(p.prosrc) = '${md5(body)}'`);
      const { rows } = await db.query<{ src: string }>(
        "select prosrc as src from pg_proc where oid = to_regprocedure($1)",
        [fn.signature],
      );
      expect(rows[0].src, fn.name).toBe(body);
    }
  });

  it("MB3 · el deshacer quita las cuatro funciones y las tablas de la etapa A siguen; volver a aplicar las deja", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(down);
      for (const fn of FUNCTIONS) expect(await exists(fn.signature), fn.name).toBe(false);
      expect(await exists("public.mfa_alert_expect(uuid, uuid)")).toBe(true);
      expect(
        (await db.query("select to_regclass('public.mfa_annul_links') as t")).rows[0].t,
      ).not.toBeNull();
      await db.query(up);
      for (const fn of FUNCTIONS) expect(await exists(fn.signature), fn.name).toBe(true);
      const { rows } = await db.query<{ anon: boolean; service: boolean }>(
        `select has_function_privilege('anon', 'public.mfa_annul_claim(text)', 'execute') as anon,
                has_function_privilege('service_role', 'public.mfa_annul_claim(text)', 'execute') as service`,
      );
      expect(rows[0]).toEqual({ anon: false, service: true });
    }));

  it("MB4 · el deshacer se NIEGA a correr dos veces", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(down);
      expect((await expectSqlError(db, down)).message).toMatch(/ya no es la de esta migracion/);
    }));

  it("MB5 · si otra migración redefinió una función, se NIEGA y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(`create or replace function public.mfa_annul_release(p_link_id uuid) returns boolean
        language plpgsql security definer set search_path = '' as $f$ begin return true; end $f$`);
      expect((await expectSqlError(db, down)).message).toMatch(/ya no es la de esta migracion/);
      expect(await exists("public.mfa_annul_claim(text)")).toBe(true);
    }));

  it("MB6 · si OTRA función nombra las de H-118b, se NIEGA (borrarlas la rompería)", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(`create function app.otra_toma_enlaces() returns jsonb
        language sql security definer set search_path = '' as $f$ select public.mfa_annul_claim('x') $f$`);
      expect((await expectSqlError(db, down)).message).toMatch(/otra funcion nombra/);
      expect(await exists("public.mfa_annul_complete(uuid)")).toBe(true);
    }));

  it("MB7 · con una anulación en curso (enlace tomado ahora) se NIEGA; ya soltado o vencido el plazo, no", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const user = await createUser(db);
      const alert = await db.query<{ id: string }>(
        `insert into public.mfa_enrollment_alerts (user_id, factor_id, state, expected_until)
         values ($1, gen_random_uuid(), 'sent', now()) returning id`,
        [user.id],
      );
      const link = await db.query<{ id: string }>(
        `insert into public.mfa_annul_links (alert_id, user_id, token_sha256, expires_at, claimed_until)
         values ($1, $2, $3, now() + interval '1 hour', now() + interval '1 minute') returning id`,
        [alert.rows[0].id, user.id, randomBytes(32).toString("hex")],
      );
      expect((await expectSqlError(db, down)).message).toMatch(/anulacion en curso/);
      expect(await exists("public.mfa_annul_claim(text)")).toBe(true);
      await db.query("update public.mfa_annul_links set claimed_until = null where id = $1", [
        link.rows[0].id,
      ]);
      await db.query(down);
      expect(await exists("public.mfa_annul_claim(text)")).toBe(false);
    }));
});
