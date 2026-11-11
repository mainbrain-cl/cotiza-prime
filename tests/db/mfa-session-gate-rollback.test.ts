// 🟢 PRUEBAS · Supabase local, datos ficticios.
// H-004a · migración 20261112100000_mfa_session_gate (decisión D1-B de Aarón: la base también exige el segundo paso).
// Redefine `app.current_tenant_id()` y `app.my_tenant_ids()`, agrega `app.second_step_pending()`, cambia la política
// `members_select` y amplía la lista de alcances del límite de intentos. Aquí: que el archivo y su deshacer empiezan con
// `lock_timeout` y su verificador, que el deshacer devuelve las funciones EXACTAMENTE a su texto anterior (con los mismos
// atributos y permisos) y la política a la anterior, que se puede volver a aplicar, que se niega a correr dos veces o si
// otra migración tocó las funciones, y que con el deshacer el segundo paso deja de exigirse en la base. Se ejecutan los
// archivos reales dentro de una transacción que se deshace; el deshacer completo y en orden lo prueba
// `npm run test:db:rollbacks`.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TENANT_HEADER,
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  expectSqlError,
  withTx,
} from "./helpers";
import { functionBodyIn } from "./migration-files";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const NAME = "20261112100000_mfa_session_gate";
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
/** La migración donde nacieron las dos funciones: a su texto vuelve el deshacer. */
const original = read("migrations", "20261001120200_tenants_profiles_members.sql");
/** Las cuatro funciones públicas (ronda 1): la migración que las define hoy y la línea que esta migración les agrega. */
const PUBLIC_FUNCTIONS = [
  {
    name: "public.create_tenant",
    signature: "public.create_tenant(text, text, text, text, text)",
    source: read("migrations", "20261001140100_create_tenant_contact_email_check.sql"),
  },
  {
    name: "public.accept_invitation",
    signature: "public.accept_invitation(text)",
    source: read("migrations", "20261109120000_member_invitation_creator.sql"),
  },
  {
    name: "public.invitation_preview",
    signature: "public.invitation_preview(text)",
    source: read("migrations", "20261105100000_invitation_preview_read_only.sql"),
  },
  {
    name: "public.accept_current_legal_documents",
    signature: "public.accept_current_legal_documents()",
    source: read("migrations", "20261001120400_legal.sql"),
  },
] as const;
const GATE_LINE =
  "  if app.second_step_pending() then\n    raise exception 'second_step_required' using errcode = '42501';\n  end if;\n";

const TENANT_ID = "app.current_tenant_id()";
const MY_TENANTS = "app.my_tenant_ids()";
const PENDING = "app.second_step_pending()";
const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const code = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

type Definition = {
  src: string;
  lang: string;
  secdef: boolean;
  cfg: string[] | null;
  volatility: string;
  returns: string;
  anon: boolean;
  auth: boolean;
};

async function definition(signature: string): Promise<Definition | null> {
  const { rows } = await db.query<Definition>(
    `select p.prosrc as src, l.lanname as lang, p.prosecdef as secdef, p.proconfig as cfg, p.provolatile as volatility,
            pg_get_function_result(p.oid) as returns,
            has_function_privilege('anon', p.oid, 'execute') as anon,
            has_function_privilege('authenticated', p.oid, 'execute') as auth
       from pg_proc p join pg_language l on l.oid = p.prolang
      where p.oid = to_regprocedure($1)`,
    [signature],
  );
  return rows[0] ?? null;
}

const membersPolicy = async (): Promise<string> =>
  (
    await db.query<{ qual: string }>(
      "select qual from pg_policies where schemaname = 'public' and tablename = 'members' and policyname = 'members_select'",
    )
  ).rows[0].qual;

const GATED_POLICIES = [
  ["profiles", "profiles_select"],
  ["profiles", "profiles_update"],
  ["legal_acceptances", "legal_acceptances_select"],
] as const;

/** Texto (qual + with_check) de las tres políticas que la ronda 1 cierra (members_select va aparte). */
async function gatedPolicies(): Promise<Record<string, string>> {
  const { rows } = await db.query<{ policyname: string; text: string }>(
    `select policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') as text
       from pg_policies where schemaname = 'public' and (tablename, policyname) in (${GATED_POLICIES.map(
         ([table, name]) => `('${table}', '${name}')`,
       ).join(", ")})`,
  );
  return Object.fromEntries(rows.map((row) => [row.policyname, row.text]));
}

const scopeCheck = async (): Promise<string> =>
  (
    await db.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'auth_rate_limits_scope_check'",
    )
  ).rows[0].def;

describe("la migración mfa_session_gate y su deshacer", () => {
  it("MR1 · los dos archivos empiezan con `lock_timeout` de 3 s y su verificador; el deshacer solo redefine las dos funciones y borra la nueva", () => {
    for (const sql of [up, down]) {
      const [first, ...rest] = code(sql).split(";");
      expect(first.replace(/\s+/g, " ").trim()).toBe("set local lock_timeout = '3s'");
      expect(rest.join(";").trimStart()).toMatch(
        /^do \$\$ begin\s+if current_setting\('lock_timeout'\) <> '3s' then\s+raise exception [\s\S]*?;\s+end if;/i,
      );
    }
    const defined = (sql: string) =>
      [...code(sql).matchAll(/create (?:or replace )?function ([a-z_.]+)\(/gi)].map((m) => m[1]);
    const publicNames = PUBLIC_FUNCTIONS.map((f) => f.name);
    expect(defined(up)).toEqual([
      "app.second_step_pending",
      "app.current_tenant_id",
      "app.my_tenant_ids",
      ...publicNames,
    ]);
    expect(defined(down)).toEqual(["app.current_tenant_id", "app.my_tenant_ids", ...publicNames]);
    expect(code(down)).toMatch(/drop function app\.second_step_pending\(\);/);
    expect(code(down)).not.toMatch(/\b(truncate|alter\s+table\s+public\.(?!auth_rate_limits))\b/i);
    // Toda función con `security definer` fija `search_path` vacío.
    for (const sql of [up, down]) {
      const count = (code(sql).match(/security definer/g) ?? []).length;
      expect((code(sql).match(/security definer set search_path = ''/g) ?? []).length).toBe(count);
    }
  });

  it("MR2 · las funciones vigentes son las del archivo; el cuerpo de las dos viejas se copió LITERAL y solo suma la línea nueva", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      expect((await definition(TENANT_ID))!.src).toBe(functionBodyIn(up, "app.current_tenant_id"));
      expect((await definition(MY_TENANTS))!.src).toBe(functionBodyIn(up, "app.my_tenant_ids"));
      expect((await definition(PENDING))!.src).toBe(functionBodyIn(up, "app.second_step_pending"));

      // Quitando la línea nueva se obtiene exactamente el cuerpo de la migración donde nacieron.
      const newTenantId = functionBodyIn(up, "app.current_tenant_id").replace(
        "  if app.second_step_pending() then\n    return null;\n  end if;\n",
        "",
      );
      expect(newTenantId).toBe(functionBodyIn(original, "app.current_tenant_id"));
      const newMyTenants = functionBodyIn(up, "app.my_tenant_ids").replace(
        "    and not app.second_step_pending()\n",
        "",
      );
      expect(newMyTenants).toBe(functionBodyIn(original, "app.my_tenant_ids"));

      // Las cuatro públicas: la vigente es la del archivo, y quitando SOLO la línea nueva queda el cuerpo de la
      // migración donde se definió por última vez.
      for (const fn of PUBLIC_FUNCTIONS) {
        const inFile = functionBodyIn(up, fn.name);
        expect((await definition(fn.signature))!.src, fn.name).toBe(inFile);
        expect(inFile.split(GATE_LINE).length, `${fn.name}: una sola línea nueva`).toBe(2);
        expect(inFile.replace(GATE_LINE, ""), fn.name).toBe(functionBodyIn(fn.source, fn.name));
      }
    }));

  it("MR3 · el deshacer devuelve las funciones EXACTAMENTE a su texto anterior, con los mismos atributos y permisos, y la política a la anterior", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const before = {
        tenant: (await definition(TENANT_ID))!,
        mine: (await definition(MY_TENANTS))!,
        pending: (await definition(PENDING))!,
        policy: await membersPolicy(),
        policies: await gatedPolicies(),
        publics: await Promise.all(PUBLIC_FUNCTIONS.map((fn) => definition(fn.signature))),
        scopes: await scopeCheck(),
      };
      expect(
        Object.values(before.policies).every((qual) => qual.includes("second_step_pending")),
      ).toBe(true);
      expect(before.pending).toMatchObject({ secdef: true, anon: false, auth: true });
      expect(before.policy).toContain("second_step_pending");
      expect(before.scopes).toContain("mfa_code_used");

      await db.query(down);
      const after = {
        tenant: (await definition(TENANT_ID))!,
        mine: (await definition(MY_TENANTS))!,
      };
      expect(after.tenant.src).toBe(functionBodyIn(original, "app.current_tenant_id"));
      expect(after.mine.src).toBe(functionBodyIn(original, "app.my_tenant_ids"));
      for (const key of ["tenant", "mine"] as const) {
        expect({ ...after[key], src: "" }).toEqual({ ...before[key], src: "" });
        expect(after[key]).toMatchObject({ secdef: true, anon: false, auth: true });
        expect(after[key].cfg).toContain('search_path=""');
      }
      expect(await definition(PENDING)).toBeNull();
      expect(await membersPolicy()).not.toContain("second_step_pending");
      for (const qual of Object.values(await gatedPolicies())) {
        expect(qual).not.toContain("second_step_pending");
      }
      // Las cuatro públicas vuelven EXACTAMENTE a su texto anterior, con los mismos atributos y permisos.
      for (const [index, fn] of PUBLIC_FUNCTIONS.entries()) {
        const restored = (await definition(fn.signature))!;
        const gated = before.publics[index]!;
        expect(restored.src, fn.name).toBe(functionBodyIn(fn.source, fn.name));
        expect({ ...restored, src: "" }, fn.name).toEqual({ ...gated, src: "" });
        expect(restored, fn.name).toMatchObject({ secdef: true, anon: false, auth: true });
      }
      expect(await scopeCheck()).not.toContain("mfa_");
      expect(await scopeCheck()).toContain("invite_link_ip");

      // Volver a aplicarla deja lo mismo.
      await db.query(up);
      expect((await definition(TENANT_ID))!.src).toBe(before.tenant.src);
      expect((await definition(MY_TENANTS))!.src).toBe(before.mine.src);
      expect((await definition(PENDING))!.src).toBe(before.pending.src);
      expect(await membersPolicy()).toBe(before.policy);
      expect(await gatedPolicies()).toEqual(before.policies);
      for (const [index, fn] of PUBLIC_FUNCTIONS.entries()) {
        expect((await definition(fn.signature))!.src, fn.name).toBe(before.publics[index]!.src);
      }
      expect(await scopeCheck()).toBe(before.scopes);
    }));

  it("MR4 · el deshacer se NIEGA a correr dos veces y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(down);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/ya no es la de esta migracion/);
      expect((await definition(TENANT_ID))!.src).toBe(
        functionBodyIn(original, "app.current_tenant_id"),
      );
    }));

  it("MR4b · los md5 que exige el deshacer son los de los cuerpos de la migración (se recalculan del archivo)", () => {
    for (const name of [
      "app.second_step_pending",
      "app.current_tenant_id",
      "app.my_tenant_ids",
      ...PUBLIC_FUNCTIONS.map((fn) => fn.name),
    ]) {
      expect(code(down)).toContain(`md5(p.prosrc) = '${md5(functionBodyIn(up, name))}'`);
    }
  });

  it("MR4c · si otra migración redefinió `current_tenant_id`, el deshacer se NIEGA y no la pisa", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(`create or replace function app.current_tenant_id() returns uuid
        language plpgsql stable security definer set search_path = '' as $f$
        begin
          if app.second_step_pending() then return null; end if;
          return null; -- otra migración la redefinió y sigue nombrando el segundo paso
        end $f$`);
      const before = await definition(TENANT_ID);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/ya no es la de esta migracion/);
      expect((await definition(TENANT_ID))!.src).toBe(before!.src);
    }));

  it("MR4d · si una de las políticas ya no es la de esta migración, el deshacer se NIEGA y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(
        "alter policy profiles_update on public.profiles using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))",
      );
      const before = await gatedPolicies();
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/ya no es la de esta migracion/);
      expect(await gatedPolicies()).toEqual(before);
      expect(await definition(PENDING)).not.toBeNull();
    }));

  it("MR4e · si OTRA función o política nombra `second_step_pending`, el deshacer se NIEGA (borrarla la rompería)", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(`create function app.otra_usa_el_segundo_paso() returns boolean
        language sql stable security definer set search_path = '' as $f$ select app.second_step_pending() $f$`);
      const byFunction = await expectSqlError(db, down);
      expect(byFunction.message).toMatch(/otra funcion o politica nombra/);
      await db.query("drop function app.otra_usa_el_segundo_paso()");
      await db.query(
        "create policy otra_politica on public.catalog_items for select to authenticated using (not (select app.second_step_pending()))",
      );
      const byPolicy = await expectSqlError(db, down);
      expect(byPolicy.message).toMatch(/otra funcion o politica nombra/);
      expect(await definition(PENDING)).not.toBeNull();
    }));

  it("MR5 · con el deshacer la base deja de exigir el segundo paso; con la migración, lo exige; y los contadores nuevos se borran", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const owner = await createUser(db);
      const tenantId = await createTenantAs(db, owner);
      await db.query(
        `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
         values (gen_random_uuid(), $1, 'prueba', 'totp', 'verified', now(), now(), 'x')`,
        [owner.id],
      );
      const key = randomBytes(32).toString("hex");
      await db.query("select public.auth_limit_record_failure('mfa_code_used', $1, 5, 900, 900)", [
        key,
      ]);
      const visibleTenants = async () => {
        await db.query("reset role");
        await db.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: owner.id, role: "authenticated", aal: "aal1" }),
        ]);
        await db.query("select set_config('request.jwt.claim.sub', $1, true)", [owner.id]);
        await db.query("select set_config('request.headers', $1, true)", [
          JSON.stringify({ [TENANT_HEADER]: tenantId }),
        ]);
        await db.query("set local role authenticated");
        const n = Number(
          (await db.query<{ n: string }>("select count(*) as n from public.members")).rows[0].n,
        );
        const t = (await db.query("select app.current_tenant_id() as t")).rows[0].t;
        await db.query("reset role");
        return { members: n, current: t };
      };

      expect(await visibleTenants()).toEqual({ members: 0, current: null });
      await db.query(down);
      expect(await visibleTenants()).toEqual({ members: 1, current: tenantId });
      expect(
        (
          await db.query(
            "select count(*)::int as n from public.auth_rate_limits where key_hash = $1",
            [key],
          )
        ).rows[0].n,
      ).toBe(0);
      const rejected = await expectSqlError(
        db,
        "select public.auth_limit_record_failure('mfa_code_used', $1, 5, 900, 900)",
        [key],
      );
      expect(rejected.code).toBe("23514");

      await db.query(up);
      expect(await visibleTenants()).toEqual({ members: 0, current: null });
    }));

  it("MR6 · una cuenta sin factor se comporta igual con la migración y sin ella", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const owner = await createUser(db);
      const tenantId = await createTenantAs(db, owner);
      const resolve = async () => {
        await db.query("reset role");
        await db.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: owner.id, role: "authenticated", aal: "aal1" }),
        ]);
        await db.query("select set_config('request.jwt.claim.sub', $1, true)", [owner.id]);
        await db.query("select set_config('request.headers', $1, true)", [
          JSON.stringify({ [TENANT_HEADER]: tenantId, "x-otro": randomUUID() }),
        ]);
        await db.query("set local role authenticated");
        const row = (
          await db.query(
            "select app.current_tenant_id() as t, app.current_member_role() as r, (select count(*) from app.my_tenant_ids()) as n",
          )
        ).rows[0];
        await db.query("reset role");
        return row;
      };
      const withGate = await resolve();
      await db.query(down);
      expect(await resolve()).toEqual(withGate);
      expect(withGate.t).toBe(tenantId);
    }));
});
