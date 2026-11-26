// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · H-042 · migración 20261124110000_member_catalog_scope y su deshacer: `lock_timeout` y su verificador, `security definer` con
// `search_path` vacío, que el deshacer devuelve el gancho a lo que dejó H-041 (cuerpo exactamente `select true`, sin permiso para `authenticated`)
// y NUNCA lo borra, que borra las funciones y las dos tablas, que se puede volver a aplicar, y que se NIEGA a correr (sin cambiar nada) si el
// gancho ya no es el de la migración o si otra función nombra lo que se quita.
// Se ejecutan los archivos reales dentro de una transacción que se deshace: no queda nada. El deshacer completo y en orden lo prueba
// `npm run test:db:rollbacks`.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import { functionBodyIn } from "./migration-files";
import { addCatalogItem } from "./approval-helpers";
import { asUser, buildWorld, type World } from "./send-helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const NAME = "20261124110000_member_catalog_scope";
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
const priceLocks = read("migrations", "20261118100000_price_locks.sql");
const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const code = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

const HOOK = "app.can_quote_catalog_item(uuid)";
const GONE_FUNCTIONS = [
  "app.member_catalog_scope_max_items()",
  "app.catalog_scope_limited()",
  "app.my_catalog_scope_item_ids()",
  "public.quotable_catalog_items(text, uuid[])",
  "public.my_catalog_scope()",
  "public.set_member_catalog_scope(uuid, text, uuid[], integer)",
] as const;
const GONE_TABLES = ["member_catalog_scopes", "member_catalog_scope_items"] as const;

let db: Client;
let w: World;
beforeAll(async () => {
  db = await connect();
  w = await buildWorld(db);
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
const hookDefinition = async () =>
  (
    await db.query(
      `select p.prosrc as src, p.prosecdef as secdef, p.proconfig as cfg, p.provolatile as volatility,
              pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as returns,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p where p.oid = $1::regprocedure`,
      [HOOK],
    )
  ).rows[0];

describe("la migración member_catalog_scope y su deshacer", () => {
  it("MC1 · los dos archivos empiezan con `lock_timeout` de 3 s y su verificador; todo `security definer` fija `search_path` vacío; define lo esperado", () => {
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
    expect(defined.sort()).toEqual(
      [
        ...GONE_FUNCTIONS.map((s) => s.slice(0, s.indexOf("("))),
        "app.can_quote_catalog_item",
      ].sort(),
    );
    // no se toca el envío ni `save_quote_draft`, ni se escribe ningún nombre de rol entre comillas
    expect(code(up)).not.toMatch(
      /prepare_quote_send|save_quote_draft|'(owner|admin|approver|sales|viewer)'/i,
    );
    // nada para `anon` ni `PUBLIC`
    expect(code(up)).not.toMatch(/grant[^;]*\bto\b[^;]*\b(anon|public)\b/i);
  });

  it("MC2 · el md5 que exige el deshacer es el del cuerpo del gancho de la migración y coincide con la base", async () => {
    const body = functionBodyIn(up, "app.can_quote_catalog_item");
    expect(code(down)).toContain(`md5(p.prosrc) = '${md5(body)}'`);
    await actAsPostgres(db);
    expect((await hookDefinition()).src).toBe(body);
  });

  it("MC3 · el gancho nuevo mantiene firma, nombre de parámetro y atributos del que dejó H-041", async () => {
    await actAsPostgres(db);
    const original = priceLocks.slice(
      priceLocks.indexOf("create function app.can_quote_catalog_item"),
    );
    expect(original.slice(0, original.indexOf(";"))).toMatch(
      /\(p_catalog_item_id uuid\) returns boolean\s+language sql stable security definer set search_path = ''/,
    );
    const current = await hookDefinition();
    expect(current).toMatchObject({
      args: "p_catalog_item_id uuid",
      returns: "boolean",
      secdef: true,
      volatility: "s",
      anon: false,
      auth: true,
    });
    expect(current.cfg).toContain('search_path=""');
  });

  it("MC4 · el deshacer deja el gancho EXACTAMENTE como H-041 (`select true`, sin permiso para `authenticated`), borra funciones y tablas, y se puede volver a aplicar", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const current = await hookDefinition();
      for (const t of GONE_TABLES) expect(await tableExists(t), t).toBe(true);

      await db.query(down);
      // el gancho NUNCA se borra
      expect(await exists(HOOK)).toBe(true);
      const restored = await hookDefinition();
      expect(restored.src.trim()).toBe("select true");
      expect(restored).toMatchObject({
        secdef: true,
        volatility: "s",
        anon: false,
        auth: false,
        args: "p_catalog_item_id uuid",
        returns: "boolean",
      });
      expect(restored.cfg).toContain('search_path=""');
      for (const signature of GONE_FUNCTIONS)
        expect(await exists(signature), signature).toBe(false);
      for (const t of GONE_TABLES) expect(await tableExists(t), t).toBe(false);

      // volver a aplicar la migración deja lo mismo
      await db.query(up);
      for (const signature of GONE_FUNCTIONS) expect(await exists(signature), signature).toBe(true);
      for (const t of GONE_TABLES) expect(await tableExists(t), t).toBe(true);
      expect(await hookDefinition()).toEqual(current);
    }));

  it("MC5 · el deshacer se NIEGA a correr dos veces y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(down);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/ya no es el de esta migracion/);
      expect((await hookDefinition()).src.trim()).toBe("select true");
    }));

  it("MC6 · si OTRA migración redefinió el gancho, se NIEGA y no lo pisa ni quita nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(`create or replace function app.can_quote_catalog_item(p_catalog_item_id uuid) returns boolean
        language sql stable security definer set search_path = '' as $f$ select false $f$`);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(
        /gancho app\.can_quote_catalog_item vigente ya no es el de esta migracion/,
      );
      expect((await hookDefinition()).src.trim()).toBe("select false");
      for (const t of GONE_TABLES) expect(await tableExists(t), t).toBe(true);
      expect(await exists("public.set_member_catalog_scope(uuid, text, uuid[], integer)")).toBe(
        true,
      );
    }));

  it("MC7 · si OTRA función nombra las tablas o las funciones que se quitan, se NIEGA", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      for (const name of [
        "member_catalog_scopes",
        "member_catalog_scope_items",
        "catalog_scope_limited",
        "quotable_catalog_items",
        "my_catalog_scope",
        "set_member_catalog_scope",
      ]) {
        await db.query("savepoint s1");
        await db.query(`create function app.otra_funcion() returns void
          language plpgsql security definer set search_path = '' as $f$ begin /* ${name} */ null; end $f$`);
        const error = await expectSqlError(db, down);
        expect(error.message, name).toMatch(/otra funcion nombra/);
        await db.query("rollback to savepoint s1");
      }
      for (const t of GONE_TABLES) expect(await tableExists(t), t).toBe(true);
    }));

  it("MC8 · el deshacer pierde solo la configuración: el historial y las cotizaciones se conservan, y sin la regla un Comercial vuelve a cotizar todo", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const a = await addCatalogItem(db, w.tenantA, 10_000);
      const b = await addCatalogItem(db, w.tenantA, 10_000);
      const carla = (
        await db.query<{ id: string }>(
          "select id from public.members where tenant_id = $1 and user_id = $2",
          [w.tenantA, w.sales.id],
        )
      ).rows[0].id;
      await asUser(db, w.owner, w.tenantA);
      await db.query("select public.set_member_catalog_scope($1, 'list', $2::uuid[], 0)", [
        carla,
        [a],
      ]);
      await actAsPostgres(db);
      const audits = () =>
        db
          .query<{ n: string }>(
            "select count(*) as n from public.audit_log where resource_id = $1 and action = 'member.catalog_scope_changed'",
            [carla],
          )
          .then((r) => Number(r.rows[0].n));
      expect(await audits()).toBe(1);
      // limitada, ve solo `a`
      await asUser(db, w.sales, w.tenantA);
      expect((await db.query("select app.can_quote_catalog_item($1) as ok", [b])).rows[0].ok).toBe(
        false,
      );
      await actAsPostgres(db);

      await db.query(down);
      expect(await audits()).toBe(1);
      // sin la regla, el gancho vuelve a ser «sí» para quien tiene permiso de ejecutarlo (aquí, probado como el dueño de la base)
      expect(
        (await db.query("select app.can_quote_catalog_item($1) as ok", [randomUUID()])).rows[0].ok,
      ).toBe(true);
    }));
});
