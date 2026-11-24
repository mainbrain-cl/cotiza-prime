// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · H-041 etapa A · migración 20261118100000_price_locks y su deshacer: `lock_timeout` y su verificador, `security definer` con
// `search_path` vacío, que el deshacer quita el disparador, las ocho funciones y las dos columnas y devuelve `save_quote_draft` EXACTAMENTE
// a su texto anterior, que se puede volver a aplicar, y que se NIEGA a correr (sin cambiar nada) si `save_quote_draft` ya no es la de la
// migración (p. ej. H-048b), si el gancho de H-042 ya no es `select true`, si otra función nombra lo que se quita, o si ya se deshizo.
// Se ejecutan los archivos reales dentro de una transacción que se deshace: no queda nada. El deshacer completo y en orden lo prueba
// `npm run test:db:rollbacks`.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateQuote, type Discount } from "../../src/lib/quotes/calc";
import { actAsPostgres, connect, expectSqlError, withTx, type TestUser } from "./helpers";
import { functionBodyIn } from "./migration-files";
import { addCatalogItem } from "./approval-helpers";
import { asUser, buildWorld, line, type World } from "./send-helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const NAME = "20261118100000_price_locks";
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
const previous = read("migrations", "20261005130000_brand_server_only_logo.sql");
// H-048b (20261123100000) redefinió `save_quote_draft` encima de la de esta migración y H-042 (20261124110000) reemplazó el gancho: sus
// deshacer van PRIMERO (orden inverso) y dejan la función y el gancho exactamente como los dejó esta migración. Cada prueba de aquí los
// corre al empezar, dentro de su transacción.
// Los deshacer posteriores, en orden inverso: primero H-042 (devuelve el gancho a `select true`) y después H-048b.
const later =
  read("rollbacks", "20261124110000_member_catalog_scope.down.sql") +
  "\n" +
  read("rollbacks", "20261123100000_quote_text_fields.down.sql");
const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const code = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

const SAVE = "public.save_quote_draft(uuid, integer, uuid, jsonb, jsonb, jsonb)";
const GONE = [
  "app.can_quote_catalog_item(uuid)",
  "app.line_price_lock_broken(jsonb)",
  "app.discount_over_cap(text, numeric, numeric, integer)",
  "app.line_rule_issues(jsonb, jsonb, integer, boolean)",
  "app.locked_price_override_lines(jsonb)",
  "app.quote_line_rules_check(uuid, jsonb, jsonb)",
  "app.quote_packages_line_rules_gate()",
  "public.set_quote_max_discount(integer)",
] as const;

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
const columnExists = async (table: string, column: string) =>
  (
    await db.query<{ ok: boolean }>(
      `select exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = $1 and column_name = $2) as ok`,
      [table, column],
    )
  ).rows[0].ok;
const triggerExists = async () =>
  (
    await db.query<{ ok: boolean }>(
      `select exists (select 1 from pg_trigger
                       where tgrelid = 'public.quote_packages'::regclass
                         and tgname = 'quote_packages_a_line_rules_gate') as ok`,
    )
  ).rows[0].ok;
const saveDefinition = async () =>
  (
    await db.query(
      `select p.prosrc as src, p.prosecdef as secdef, p.proconfig as cfg, p.provolatile as volatility,
              pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as returns,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p where p.oid = $1::regprocedure`,
      [SAVE],
    )
  ).rows[0];

describe("la migración price_locks y su deshacer", () => {
  it("PL1 · los dos archivos empiezan con `lock_timeout` de 3 s y su verificador; todo `security definer` fija `search_path` vacío; define lo esperado", () => {
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
      [...GONE.map((s) => s.slice(0, s.indexOf("("))), "public.save_quote_draft"].sort(),
    );
    // el candado y el tope no se copian a `quote_items`; la migración no toca `prepare_quote_send`
    expect(code(up)).not.toMatch(
      /prepare_quote_send|quote_items\s+add column|create or replace function app\.(has_role|can)\b/i,
    );
    // todo lo que se crea con permisos: nada para `anon` ni `PUBLIC`
    expect(code(up)).not.toMatch(/grant[^;]*\bto\b[^;]*\b(anon|public)\b/i);
  });

  it("PL2 · los md5 que exige el deshacer son los del cuerpo de la migración y coinciden con la base (una vez deshecha H-048b)", () =>
    withTx(db, async () => {
      const body = functionBodyIn(up, "public.save_quote_draft");
      expect(code(down)).toContain(`md5(p.prosrc) = '${md5(body)}'`);
      await actAsPostgres(db);
      await db.query(later);
      expect((await saveDefinition()).src).toBe(body);
    }));

  it("PL3 · el deshacer quita el disparador, las ocho funciones y las dos columnas; `save_quote_draft` queda EXACTAMENTE como antes, con sus atributos y permisos", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(later);
      const current = await saveDefinition();
      expect(current.auth).toBe(true);
      expect(await triggerExists()).toBe(true);
      expect(await columnExists("catalog_items", "price_locked")).toBe(true);
      expect(await columnExists("tenants", "max_discount_bp")).toBe(true);

      await db.query(down);
      for (const signature of GONE) expect(await exists(signature), signature).toBe(false);
      expect(await triggerExists()).toBe(false);
      expect(await columnExists("catalog_items", "price_locked")).toBe(false);
      expect(await columnExists("tenants", "max_discount_bp")).toBe(false);
      const restored = await saveDefinition();
      expect(restored.src).toBe(functionBodyIn(previous, "public.save_quote_draft"));
      expect(restored.src).toContain("app.has_role('owner', 'admin', 'sales')");
      expect(restored.src).not.toContain("line_rules");
      expect({ ...restored, src: "" }).toEqual({ ...current, src: "" });
      expect(restored).toMatchObject({ secdef: true, anon: false, auth: true });
      expect(restored.cfg).toContain('search_path=""');

      // volver a aplicar la migración deja lo mismo
      await db.query(up);
      for (const signature of GONE) expect(await exists(signature), signature).toBe(true);
      expect(await triggerExists()).toBe(true);
      expect(await columnExists("catalog_items", "price_locked")).toBe(true);
      expect(await columnExists("tenants", "max_discount_bp")).toBe(true);
      expect((await saveDefinition()).src).toBe(current.src);
    }));

  it("PL4 · el deshacer se NIEGA a correr dos veces y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(later);
      await db.query(down);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/ya no es la de esta migracion/);
      expect((await saveDefinition()).src).toBe(
        functionBodyIn(previous, "public.save_quote_draft"),
      );
    }));

  it("PL5 · si OTRA migración redefinió `save_quote_draft` (p. ej. H-048b), se NIEGA y no la pisa ni quita nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const body = functionBodyIn(up, "public.save_quote_draft");
      await db.query(
        `create or replace function public.save_quote_draft(
           p_quote_id uuid, p_expected_revision integer, p_save_id uuid, p_header jsonb, p_items jsonb, p_expected_totals jsonb
         ) returns jsonb language plpgsql security definer set search_path = '' as $f$${body}\n-- redefinida por otra historia\n$f$`,
      );
      const before = await saveDefinition();
      expect(before.src).not.toBe(body);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/save_quote_draft vigente ya no es la de esta migracion/);
      expect((await saveDefinition()).src).toBe(before.src);
      expect(await triggerExists()).toBe(true);
      expect(await columnExists("tenants", "max_discount_bp")).toBe(true);
      expect(await exists("app.can_quote_catalog_item(uuid)")).toBe(true);
    }));

  it("PL6 · si H-042 reemplazó el gancho (ya no es `select true`), se NIEGA: nunca se borra a ciegas", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(later);
      await db.query(`create or replace function app.can_quote_catalog_item(p_catalog_item_id uuid) returns boolean
        language sql stable security definer set search_path = '' as $f$ select false $f$`);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/gancho app\.can_quote_catalog_item ya no es/);
      expect(await exists("app.can_quote_catalog_item(uuid)")).toBe(true);
      expect(await triggerExists()).toBe(true);
      expect(await columnExists("catalog_items", "price_locked")).toBe(true);
    }));

  it("PL7 · si OTRA función nombra lo que se quita (la regla, el gancho o las columnas), se NIEGA", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(later);
      for (const name of [
        "line_rule_issues",
        "quote_line_rules_check",
        "can_quote_catalog_item",
        "discount_over_cap",
        "set_quote_max_discount",
        "price_locked",
        "max_discount_bp",
      ]) {
        await db.query("savepoint s1");
        await db.query(`create function app.otra_funcion() returns void
          language plpgsql security definer set search_path = '' as $f$ begin /* ${name} */ null; end $f$`);
        const error = await expectSqlError(db, down);
        expect(error.message, name).toMatch(/otra funcion nombra/);
        await db.query("rollback to savepoint s1");
      }
      expect(await triggerExists()).toBe(true);
      expect(await columnExists("tenants", "max_discount_bp")).toBe(true);
    }));

  it("PL8 · el deshacer pierde solo la configuración: el evento y la auditoría de un precio bloqueado cambiado se conservan, y guardar vuelve a ser sin regla", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(later);
      const service = await addCatalogItem(db, w.tenantA, 10_000);
      await db.query("update public.catalog_items set price_locked = true where id = $1", [
        service,
      ]);
      await db.query("update public.tenants set max_discount_bp = 0 where tenant_id = $1", [
        w.tenantA,
      ]);
      const newQuote = async (user: TestUser) => {
        await asUser(db, user, w.tenantA);
        const { rows } = await db.query<{ quote_id: string }>(
          "select * from public.create_quote($1, $2)",
          [w.customerA, randomUUID()],
        );
        await actAsPostgres(db);
        return rows[0].quote_id;
      };
      const saveArgs = (quoteId: string, price: number, discount: Discount) => {
        const calc = calculateQuote({
          lines: [{ quantityMilli: 1000, unitPriceClp: price, taxTreatment: "taxable", discount }],
          globalDiscount: { kind: "none" },
          taxRateBp: 1900,
        });
        if (!calc.ok) throw new Error("cálculo inválido");
        return [
          quoteId,
          1,
          randomUUID(),
          JSON.stringify({
            customer_id: w.customerA,
            global_discount: { kind: "none", value: 0 },
          }),
          JSON.stringify([
            line({
              catalog_item_id: service,
              unit_price_clp: price,
              discount_kind: discount.kind,
              discount_value: discount.kind === "percent" ? discount.bp : 0,
            }),
          ]),
          JSON.stringify(calc.totals),
        ];
      };
      const SAVE_SQL = "select public.save_quote_draft($1, $2, $3, $4, $5, $6)";
      const count = async (table: string, where: string, id: string) =>
        Number(
          (
            await db.query<{ n: string }>(
              `select count(*) as n from public.${table} where ${where}`,
              [id],
            )
          ).rows[0].n,
        );
      const EVENT = "quote_id = $1 and type = 'locked_price_overridden'";
      const AUDIT = "resource_id = $1 and action = 'quote.locked_price_overridden'";

      // el Dueño cambia un precio bloqueado: queda evento y auditoría
      const ownerQuote = await newQuote(w.owner);
      await asUser(db, w.owner, w.tenantA);
      await db.query(SAVE_SQL, saveArgs(ownerQuote, 7_000, { kind: "none" }));
      await actAsPostgres(db);
      expect(await count("quote_events", EVENT, ownerQuote)).toBe(1);
      expect(await count("audit_log", AUDIT, ownerQuote)).toBe(1);

      // el Comercial, con la regla puesta, no puede
      const salesQuote = await newQuote(w.sales);
      await asUser(db, w.sales, w.tenantA);
      const blocked = await expectSqlError(
        db,
        SAVE_SQL,
        saveArgs(salesQuote, 7_000, { kind: "percent", bp: 5_000 }),
      );
      expect(blocked.message).toMatch(/^line_rules_invalid: /);

      await actAsPostgres(db);
      await db.query(down);
      // se conserva lo que ya pasó
      expect(await count("quote_events", EVENT, ownerQuote)).toBe(1);
      expect(await count("audit_log", AUDIT, ownerQuote)).toBe(1);
      expect(await count("quote_items", "quote_id = $1", ownerQuote)).toBe(1);
      // y sin la regla, el mismo guardado del Comercial pasa (la versión anterior no la conoce)
      await asUser(db, w.sales, w.tenantA);
      const { rows } = await db.query<{ r: { revision: number } }>(
        `${SAVE_SQL} as r`,
        saveArgs(salesQuote, 7_000, { kind: "percent", bp: 5_000 }),
      );
      expect(rows[0].r.revision).toBe(2);
    }));
});
