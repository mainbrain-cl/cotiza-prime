// 🟢 PRUEBAS · Supabase local, datos ficticios.
// H-118a · migración 20261113100000_mfa_enrollment_alerts y su deshacer. Aquí: que los dos archivos empiezan con `lock_timeout` de
// 3 s y su verificador, que el deshacer quita el disparador, las cinco funciones y las dos tablas y devuelve la lista de
// alcances a la de 20261112100000, que se puede volver a aplicar, y que se NIEGA a correr (sin cambiar nada) si una función ya
// no es la de la migración, si otra función nombra lo que borraría o si hay enlaces de anulación abiertos. Se ejecutan los
// archivos reales dentro de una transacción que se deshace; el deshacer completo y en orden lo prueba `npm run test:db:rollbacks`.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, createUser, expectSqlError, withTx } from "./helpers";
import { functionBodyIn } from "./migration-files";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const NAME = "20261113100000_mfa_enrollment_alerts";
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
/** La etapa B (20261113110000) nombra estas tablas: su deshacer va ANTES (orden inverso). */
const downB = read("rollbacks", "20261113110000_mfa_annul.down.sql");
const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const code = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

const FUNCTIONS = [
  { name: "public.mfa_alert_expect", signature: "public.mfa_alert_expect(uuid, uuid)" },
  { name: "public.mfa_alerts_reserve", signature: "public.mfa_alerts_reserve(uuid, text)" },
  { name: "public.mfa_alert_settle", signature: "public.mfa_alert_settle(uuid, text, text, text)" },
  { name: "public.mfa_alert_revert", signature: "public.mfa_alert_revert(uuid, uuid, text)" },
  { name: "app.mfa_factor_verify_gate", signature: "app.mfa_factor_verify_gate()" },
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
const tableExists = async (name: string) =>
  (await db.query<{ ok: boolean }>("select to_regclass($1) is not null as ok", [`public.${name}`]))
    .rows[0].ok;
const triggerCount = async () =>
  Number(
    (
      await db.query<{ n: string }>(
        "select count(*) as n from pg_trigger where tgrelid = 'auth.mfa_factors'::regclass and tgname = 'mfa_factor_verify_gate'",
      )
    ).rows[0].n,
  );
const scopeCheck = async () =>
  (
    await db.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'auth_rate_limits_scope_check'",
    )
  ).rows[0].def;
const previousScopes = (() => {
  const previous = read("migrations", "20261112100000_mfa_session_gate.sql");
  const start = previous.lastIndexOf("check (scope in (");
  return previous.slice(start, previous.indexOf(";", start));
})();

describe("la migración mfa_enrollment_alerts y su deshacer", () => {
  it("MA1 · los dos archivos empiezan con `lock_timeout` de 3 s y su verificador; toda función con `security definer` fija `search_path` vacío; la migración define las cinco funciones", () => {
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
  });

  it("MA2 · los md5 que exige el deshacer son los de los cuerpos de la migración (se recalculan del archivo) y coinciden con la base", async () => {
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

  it("MA3 · el deshacer quita el disparador, las cinco funciones y las dos tablas, y devuelve la lista de alcances; volver a aplicar lo deja igual", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(downB);
      // Sin restos de otras corridas (los e2e dejan enlaces abiertos): la transacción se deshace al terminar.
      await db.query("delete from public.mfa_annul_links");
      const scopesAfterUp = await scopeCheck();
      expect(scopesAfterUp).toContain("mfa_annul_token");
      expect(await triggerCount()).toBe(1);
      const key = randomBytes(32).toString("hex");
      await db.query("select public.auth_limit_record_failure('mfa_annul_ip', $1, 5, 900, 900)", [
        key,
      ]);

      await db.query(down);
      expect(await triggerCount()).toBe(0);
      for (const fn of FUNCTIONS) expect(await exists(fn.signature), fn.name).toBe(false);
      expect(await tableExists("mfa_enrollment_alerts")).toBe(false);
      expect(await tableExists("mfa_annul_links")).toBe(false);
      const scopesAfterDown = await scopeCheck();
      expect(scopesAfterDown).not.toContain("mfa_annul");
      expect(scopesAfterDown).toContain("mfa_code_used");
      expect(previousScopes).toContain("'mfa_code_used'");
      expect(
        (await db.query("select 1 from public.auth_rate_limits where key_hash = $1", [key]))
          .rowCount,
      ).toBe(0);
      // Sin el disparador, un factor vuelve a poder verificarse sin permiso (es la advertencia del deshacer).
      const user = await createUser(db);
      const { rows } = await db.query<{ id: string }>(
        `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
         values (gen_random_uuid(), $1, 'p', 'totp', 'unverified', now(), now(), 'x') returning id`,
        [user.id],
      );
      await db.query("update auth.mfa_factors set status = 'verified' where id = $1", [rows[0].id]);

      await db.query(up);
      expect(await triggerCount()).toBe(1);
      for (const fn of FUNCTIONS) expect(await exists(fn.signature), fn.name).toBe(true);
      expect(await tableExists("mfa_enrollment_alerts")).toBe(true);
      expect(await scopeCheck()).toBe(scopesAfterUp);
    }));

  it("MA4 · el deshacer se NIEGA a correr dos veces y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(downB);
      // Sin restos de otras corridas (los e2e dejan enlaces abiertos): la transacción se deshace al terminar.
      await db.query("delete from public.mfa_annul_links");
      await db.query(down);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/ya no es la de esta migracion/);
    }));

  it("MA5 · si otra migración redefinió una de las funciones, el deshacer se NIEGA y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(downB);
      // Sin restos de otras corridas (los e2e dejan enlaces abiertos): la transacción se deshace al terminar.
      await db.query("delete from public.mfa_annul_links");
      await db.query(`create or replace function public.mfa_alert_revert(p_user_id uuid, p_factor_id uuid, p_error_code text) returns text
        language plpgsql security definer set search_path = '' as $f$ begin return 'none'; end $f$`);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/ya no es la de esta migracion/);
      expect(await triggerCount()).toBe(1);
      expect(await tableExists("mfa_annul_links")).toBe(true);
    }));

  it("MA6 · si OTRA función nombra las funciones o las tablas, el deshacer se NIEGA (borrarlas la rompería)", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(downB);
      // Sin restos de otras corridas (los e2e dejan enlaces abiertos): la transacción se deshace al terminar.
      await db.query("delete from public.mfa_annul_links");
      await db.query(`create function app.otra_usa_los_enlaces() returns bigint
        language sql stable security definer set search_path = '' as $f$ select count(*) from public.mfa_annul_links $f$`);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/otra funcion nombra/);
      expect(await tableExists("mfa_annul_links")).toBe(true);
    }));

  it("MA7 · con enlaces de anulación abiertos el deshacer se NIEGA; usados o vencidos no lo detienen", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(downB);
      // Sin restos de otras corridas (los e2e dejan enlaces abiertos): la transacción se deshace al terminar.
      await db.query("delete from public.mfa_annul_links");
      const user = await createUser(db);
      const { rows } = await db.query<{ id: string }>(
        `insert into public.mfa_enrollment_alerts (user_id, factor_id, state, expected_until)
         values ($1, gen_random_uuid(), 'sent', now()) returning id`,
        [user.id],
      );
      const link = (
        await db.query<{ id: string }>(
          `insert into public.mfa_annul_links (alert_id, user_id, token_sha256, expires_at)
           values ($1, $2, $3, now() + interval '1 hour') returning id`,
          [rows[0].id, user.id, randomBytes(32).toString("hex")],
        )
      ).rows[0].id;
      const refused = await expectSqlError(db, down);
      expect(refused.message).toMatch(/enlaces de anulacion abiertos/);
      expect(await tableExists("mfa_annul_links")).toBe(true);
      await db.query("update public.mfa_annul_links set used_at = now() where id = $1", [link]);
      await db.query(down);
      expect(await tableExists("mfa_annul_links")).toBe(false);
    }));

  it("MA8 · con las funciones de la etapa B todavía puestas, el deshacer de la etapa A se NIEGA (las nombran): hay que deshacer primero la B", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/otra funcion nombra/);
      await db.query(downB);
      // Sin restos de otras corridas (los e2e dejan enlaces abiertos): la transacción se deshace al terminar.
      await db.query("delete from public.mfa_annul_links");
      await db.query(down);
      expect(await tableExists("mfa_annul_links")).toBe(false);
    }));
});
