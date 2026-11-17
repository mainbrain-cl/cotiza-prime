// 🟢 PRUEBAS · Supabase local, datos ficticios.
// H-004b etapa B · migración 20261116100000_mfa_recovery_codes y su deshacer: lock_timeout y su verificador, `security definer` con
// `search_path` vacío, que el deshacer quita las siete funciones y la tabla, que se puede volver a aplicar y que se NIEGA a correr
// (sin cambiar nada) si una función ya no es la de la migración, si otra función las nombra, si hay un código tomado ahora mismo o
// si hay juegos vigentes. Se ejecutan los archivos reales dentro de una transacción que se deshace; NO se borra ni se vacía nada
// que persista: lo que una prueba quita de la tabla lo quita DENTRO de esa transacción y se recupera al terminar. El deshacer
// completo y en orden lo prueba `npm run test:db:rollbacks`.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, createUser, expectSqlError, withTx } from "./helpers";
import { functionBodyIn } from "./migration-files";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const NAME = "20261116100000_mfa_recovery_codes";
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const code = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

const FUNCTIONS = [
  {
    name: "public.mfa_recovery_codes_replace",
    signature: "public.mfa_recovery_codes_replace(uuid, uuid, text[])",
  },
  {
    name: "public.mfa_recovery_code_claim",
    signature: "public.mfa_recovery_code_claim(uuid, text)",
  },
  {
    name: "public.mfa_recovery_code_complete",
    signature: "public.mfa_recovery_code_complete(uuid)",
  },
  {
    name: "public.mfa_recovery_code_release",
    signature: "public.mfa_recovery_code_release(uuid)",
  },
  {
    name: "public.mfa_recovery_codes_acknowledge",
    signature: "public.mfa_recovery_codes_acknowledge(uuid, uuid)",
  },
  {
    name: "public.mfa_recovery_codes_status",
    signature: "public.mfa_recovery_codes_status(uuid)",
  },
  {
    name: "public.mfa_recovery_codes_revoke",
    signature: "public.mfa_recovery_codes_revoke(uuid)",
  },
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
const tableExists = async () =>
  (
    await db.query<{ ok: boolean }>(
      "select to_regclass('public.mfa_recovery_codes') is not null as ok",
    )
  ).rows[0].ok;

/**
 * Deja la tabla sin las filas que otras pruebas o la persona que usa esta base local hayan dejado, SOLO dentro de la transacción
 * de la prueba (se deshace al terminar): el deshacer mira la tabla entera y no debe depender de lo que haya fuera.
 */
const clearInsideTransaction = () => db.query("delete from public.mfa_recovery_codes");

async function addVerifiedFactor(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
     values (gen_random_uuid(), $1, 'f', 'totp', 'verified', now(), now(), 'x') returning id`,
    [userId],
  );
  return rows[0].id;
}
async function addCode(
  userId: string,
  factorId: string,
  extra: { claimedUntil?: string; used?: boolean } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.mfa_recovery_codes (user_id, set_id, factor_id, code_hash, claimed_until, used_at)
     values ($1, gen_random_uuid(), $2, $3, $4::timestamptz, case when $5 then now() end) returning id`,
    [
      userId,
      factorId,
      randomBytes(32).toString("hex"),
      extra.claimedUntil ?? null,
      extra.used ?? false,
    ],
  );
  return rows[0].id;
}

describe("la migración mfa_recovery_codes y su deshacer", () => {
  it("MR1 · los dos archivos empiezan con `lock_timeout` de 3 s y su verificador; todo `security definer` fija `search_path` vacío; la migración define las siete funciones y la tabla", () => {
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
    expect([...code(up).matchAll(/create table ([a-z_.]+)/gi)].map((m) => m[1])).toEqual([
      "public.mfa_recovery_codes",
    ]);
    // La migración no reescribe nada que ya exista (solo crea) y el deshacer solo quita lo suyo.
    expect(code(up)).not.toMatch(/create or replace|alter function|drop /i);
    const altered = [...code(up).matchAll(/alter table ([a-z_.]+)/gi)].map((m) => m[1]);
    expect(altered.every((table) => table === "public.mfa_recovery_codes")).toBe(true);
    expect(code(down)).not.toMatch(/alter table|truncate|delete from|update /i);
    expect([...code(down).matchAll(/^drop table ([a-z_.]+)/gim)].map((m) => m[1])).toEqual([
      "public.mfa_recovery_codes",
    ]);
  });

  it("MR2 · los md5 que exige el deshacer son los de los cuerpos de la migración y coinciden con la base", async () => {
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

  it("MR3 · el deshacer quita las siete funciones y la tabla; volver a aplicar la migración las deja otra vez, con sus permisos", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await clearInsideTransaction();
      await db.query(down);
      for (const fn of FUNCTIONS) expect(await exists(fn.signature), fn.name).toBe(false);
      expect(await tableExists()).toBe(false);
      await db.query(up);
      for (const fn of FUNCTIONS) expect(await exists(fn.signature), fn.name).toBe(true);
      expect(await tableExists()).toBe(true);
      const { rows } = await db.query<{ anon: boolean; service: boolean; table_anon: boolean }>(
        `select has_function_privilege('anon', 'public.mfa_recovery_code_claim(uuid, text)', 'execute') as anon,
                has_function_privilege('service_role', 'public.mfa_recovery_code_claim(uuid, text)', 'execute') as service,
                has_table_privilege('anon', 'public.mfa_recovery_codes', 'select') as table_anon`,
      );
      expect(rows[0]).toEqual({ anon: false, service: true, table_anon: false });
    }));

  it("MR4 · el deshacer se NIEGA a correr dos veces", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await clearInsideTransaction();
      await db.query(down);
      expect((await expectSqlError(db, down)).message).toMatch(/ya no es la de esta migracion/);
    }));

  it("MR5 · si otra migración redefinió una función, se NIEGA y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await clearInsideTransaction();
      await db.query(`create or replace function public.mfa_recovery_code_release(p_code_id uuid) returns boolean
        language plpgsql security definer set search_path = '' as $f$ begin return true; end $f$`);
      expect((await expectSqlError(db, down)).message).toMatch(/ya no es la de esta migracion/);
      expect(await exists("public.mfa_recovery_code_claim(uuid, text)")).toBe(true);
      expect(await tableExists()).toBe(true);
    }));

  it("MR6 · si OTRA función nombra una de estas funciones o la tabla, se NIEGA (borrarlas la rompería)", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await clearInsideTransaction();
      await db.query("savepoint s1");
      await db.query(`create function app.otra_toma_codigos() returns jsonb
        language sql security definer set search_path = '' as $f$ select public.mfa_recovery_code_claim(null, 'x') $f$`);
      expect((await expectSqlError(db, down)).message).toMatch(/otra funcion nombra/);
      expect(await exists("public.mfa_recovery_codes_status(uuid)")).toBe(true);
      await db.query("rollback to savepoint s1");
      await db.query(`create function app.otra_lee_tabla() returns bigint
        language sql security definer set search_path = '' as $f$ select count(*) from public.mfa_recovery_codes $f$`);
      expect((await expectSqlError(db, down)).message).toMatch(/otra funcion nombra/);
      expect(await tableExists()).toBe(true);
    }));

  it("MR7 · con un código tomado ahora mismo (un uso en curso) se NIEGA; pasado el plazo del uso, ya no es por eso", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await clearInsideTransaction();
      const user = await createUser(db);
      const factor = await addVerifiedFactor(user.id);
      const taken = await addCode(user.id, factor, {
        claimedUntil: new Date(Date.now() + 60_000).toISOString(),
      });
      expect((await expectSqlError(db, down)).message).toMatch(/tomados ahora mismo/);
      expect(await exists("public.mfa_recovery_code_claim(uuid, text)")).toBe(true);
      // Vencido el plazo, deja de ser un uso en curso; sigue negándose, pero por el juego vigente (d).
      await db.query(
        "update public.mfa_recovery_codes set claimed_until = now() - interval '1 second' where id = $1",
        [taken],
      );
      expect((await expectSqlError(db, down)).message).toMatch(/vigentes/);
    }));

  it("MR8 · con un juego vigente (códigos sin usar y su factor verificado) se NIEGA y no borra nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await clearInsideTransaction();
      const user = await createUser(db);
      const factor = await addVerifiedFactor(user.id);
      await addCode(user.id, factor);
      expect((await expectSqlError(db, down)).message).toMatch(/vigentes/);
      expect(await tableExists()).toBe(true);
      const left = await db.query<{ n: string }>(
        "select count(*) as n from public.mfa_recovery_codes",
      );
      expect(Number(left.rows[0].n)).toBe(1);
      for (const fn of FUNCTIONS) expect(await exists(fn.signature), fn.name).toBe(true);
    }));

  it("MR9 · lo que NO es un juego vigente no lo impide: un código ya usado o uno cuyo factor se borró (queda solo el rastro)", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await clearInsideTransaction();
      const user = await createUser(db);
      const factor = await addVerifiedFactor(user.id);
      await addCode(user.id, factor, { used: true });
      await addCode(user.id, randomUUID());
      await db.query(down);
      expect(await tableExists()).toBe(false);
      for (const fn of FUNCTIONS) expect(await exists(fn.signature), fn.name).toBe(false);
    }));
});
