// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · H-048b etapa A · migración 20261123100000_quote_text_fields y su deshacer: `lock_timeout` y su verificador, `security definer`
// con `search_path` vacío, que el deshacer quita las dos columnas y la función del tope y devuelve `save_quote_draft` EXACTAMENTE a la
// versión de H-041, que se puede volver a aplicar, y que se NIEGA a correr (sin cambiar nada) si `save_quote_draft` ya no es la de la
// migración (p. ej. H-042 o H-041b), si otra función lee las columnas, o si ya se deshizo. Más la paridad del tope con la aplicación.
// Se ejecutan los archivos reales dentro de una transacción que se deshace: no queda nada. El deshacer completo y en orden lo prueba
// `npm run test:db:rollbacks`.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUOTE_TEXT_MAX_LENGTH } from "../../src/lib/quotes/validity";
import { actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import { functionBodyIn } from "./migration-files";
import { asUser, buildWorld, type World } from "./send-helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const NAME = "20261123100000_quote_text_fields";
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
const previous = read("migrations", "20261118100000_price_locks.sql");
const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const code = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

const SAVE = "public.save_quote_draft(uuid, integer, uuid, jsonb, jsonb, jsonb)";
const MAX = "app.quote_text_max_length()";
// la huella de la versión de H-041 que exige el deshacer de H-041 (`price-locks-rollback.test.ts` PL2 la recalcula)
const H041_SAVE_MD5 = "103579dac268fc9032bf33896d36b6a9";

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
const columnExists = async (column: string) =>
  (
    await db.query<{ ok: boolean }>(
      `select exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'quotes' and column_name = $1) as ok`,
      [column],
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

describe("la migración quote_text_fields y su deshacer", () => {
  it("QT1 · los dos archivos empiezan con `lock_timeout` de 3 s y su verificador; todo `security definer` fija `search_path` vacío; define lo esperado", () => {
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
    expect(defined.sort()).toEqual(["app.quote_text_max_length", "public.save_quote_draft"]);
    // no se toca el envío, el paquete ni sus disparadores, ni la matriz de permisos
    expect(code(up)).not.toMatch(
      /prepare_quote_send|quote_packages|create (or replace )?trigger|create or replace function app\.(has_role|can)\b|\bgrant\b/i,
    );
  });

  it("QT2 · el tope de la base es el de la aplicación y las dos columnas lo exigen", async () => {
    await actAsPostgres(db);
    const { rows } = await db.query<{ n: number }>(`select ${MAX} as n`);
    expect(rows[0].n).toBe(QUOTE_TEXT_MAX_LENGTH);
    const checks = await db.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = 'public.quotes'::regclass and c.contype = 'c'
          and pg_get_constraintdef(c.oid) ~ '(exclusions|footer_note)'`,
    );
    expect(checks.rows).toHaveLength(2);
    for (const { def } of checks.rows) expect(def).toContain("quote_text_max_length");
    // `anon`, `authenticated` y `PUBLIC` no ejecutan la función del tope (solo la usan las restricciones y `save_quote_draft`)
    const privileges = await db.query<{ anon: boolean; auth: boolean }>(
      `select has_function_privilege('anon', $1::regprocedure, 'execute') as anon,
              has_function_privilege('authenticated', $1::regprocedure, 'execute') as auth`,
      [MAX],
    );
    expect(privileges.rows[0]).toEqual({ anon: false, auth: false });
  });

  it("QT3 · los md5 son los del cuerpo de la migración y de la versión de H-041, y coinciden con la base", async () => {
    const body = functionBodyIn(up, "public.save_quote_draft");
    expect(code(down)).toContain(`md5(p.prosrc) = '${md5(body)}'`);
    expect(md5(functionBodyIn(previous, "public.save_quote_draft"))).toBe(H041_SAVE_MD5);
    expect(md5(functionBodyIn(down, "public.save_quote_draft"))).toBe(H041_SAVE_MD5);
    await actAsPostgres(db);
    expect((await saveDefinition()).src).toBe(body);
  });

  it("QT4 · `save_quote_draft` solo cambia lo previsto respecto de la de H-041", () => {
    // Quitadas las seis líneas de cada campo, la nueva queda idéntica a la de H-041 (salvo el comentario y la lista de claves)
    const prev = functionBodyIn(previous, "public.save_quote_draft");
    const next = functionBodyIn(up, "public.save_quote_draft");
    const normalized = next
      .replace("  v_excl      text;\n  v_note      text;\n", "")
      .replace(", 'exclusions', 'footer_note'", "")
      .replace("  v_excl := q.exclusions;\n  v_note := q.footer_note;\n", "")
      .replace(/  if p_header \? 'exclusions' then[\s\S]*?\n  end if;\n/, "")
      .replace(/  if p_header \? 'footer_note' then[\s\S]*?\n  end if;\n/, "")
      .replace(
        "    exclusions                  = v_excl,\n    footer_note                 = v_note,\n",
        "",
      )
      .replace(
        "-- Observaciones, condiciones, exclusiones y notas al pie:",
        "-- Observaciones y condiciones:",
      );
    expect(normalized).toBe(prev);
  });

  it("QT5 · el deshacer quita las dos columnas y la función del tope; `save_quote_draft` queda EXACTAMENTE como la de H-041, con sus atributos y permisos; se puede volver a aplicar", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const current = await saveDefinition();
      expect(current.auth).toBe(true);
      expect(await columnExists("exclusions")).toBe(true);
      expect(await columnExists("footer_note")).toBe(true);

      await db.query(down);
      expect(await exists(MAX)).toBe(false);
      expect(await columnExists("exclusions")).toBe(false);
      expect(await columnExists("footer_note")).toBe(false);
      const restored = await saveDefinition();
      expect(restored.src).toBe(functionBodyIn(previous, "public.save_quote_draft"));
      expect(md5(restored.src)).toBe(H041_SAVE_MD5);
      expect({ ...restored, src: "" }).toEqual({ ...current, src: "" });
      expect(restored).toMatchObject({ secdef: true, anon: false, auth: true });
      expect(restored.cfg).toContain('search_path=""');

      await db.query(up);
      expect(await exists(MAX)).toBe(true);
      expect(await columnExists("exclusions")).toBe(true);
      expect(await columnExists("footer_note")).toBe(true);
      expect((await saveDefinition()).src).toBe(current.src);
    }));

  it("QT6 · el deshacer se NIEGA a correr dos veces y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(down);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/ya no es la de esta migracion/);
      expect((await saveDefinition()).src).toBe(
        functionBodyIn(previous, "public.save_quote_draft"),
      );
    }));

  it("QT7 · si OTRA migración redefinió `save_quote_draft` (H-042, H-041b…), se NIEGA y no la pisa ni quita nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const body = functionBodyIn(up, "public.save_quote_draft");
      await db.query(
        `create or replace function public.save_quote_draft(
           p_quote_id uuid, p_expected_revision integer, p_save_id uuid, p_header jsonb, p_items jsonb, p_expected_totals jsonb
         ) returns jsonb language plpgsql security definer set search_path = '' as $f$${body}\n-- redefinida por otra historia\n$f$`,
      );
      const before = await saveDefinition();
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/save_quote_draft vigente ya no es la de esta migracion/);
      expect((await saveDefinition()).src).toBe(before.src);
      expect(await columnExists("exclusions")).toBe(true);
      expect(await exists(MAX)).toBe(true);
    }));

  it("QT8 · si OTRA función nombra las columnas (con alias o sueltas) o el tope, se NIEGA; los textos 'exclusions' y 'footer_note' de `app.snippet_kinds()` no cuentan", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      for (const name of [
        "q.exclusions",
        "qt.footer_note",
        "public.quotes.exclusions",
        "app.quote_text_max_length",
        // sin alias: una copia futura de los textos (H-069, H-070) los nombraría así
        "insert into public.quotes (exclusions, footer_note) select exclusions, footer_note from public.quotes",
        "select footer_note from public.quotes",
        "exclusions,",
      ]) {
        await db.query("savepoint s1");
        await db.query(`create function app.otra_funcion() returns void
          language plpgsql security definer set search_path = '' as $f$ begin /* ${name} */ null; end $f$`);
        const error = await expectSqlError(db, down);
        expect(error.message, name).toMatch(/otra funcion nombra/);
        await db.query("rollback to savepoint s1");
      }
      // sin otra función, el deshacer corre aunque `app.snippet_kinds()` nombre los dos textos como tipos de texto guardado
      expect(
        (await db.query<{ k: string[] }>("select app.snippet_kinds() as k")).rows[0].k,
      ).toEqual(expect.arrayContaining(["exclusions", "footer_note"]));
      await db.query(down);
      expect(await columnExists("exclusions")).toBe(false);
    }));

  it("QT9 · el deshacer pierde solo lo escrito en los dos campos: la cotización y sus líneas se conservan, y guardar vuelve a rechazar las claves nuevas", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await asUser(db, w.sales, w.tenantA);
      const { rows } = await db.query<{ quote_id: string }>(
        "select * from public.create_quote($1, $2)",
        [w.customerA, randomUUID()],
      );
      const quoteId = rows[0].quote_id;
      await actAsPostgres(db);
      await db.query("update public.quotes set exclusions = 'No incluye embalaje' where id = $1", [
        quoteId,
      ]);
      await db.query(down);
      const kept = await db.query("select id, number_display from public.quotes where id = $1", [
        quoteId,
      ]);
      expect(kept.rows).toHaveLength(1);
      await asUser(db, w.sales, w.tenantA);
      const error = await expectSqlError(
        db,
        "select public.save_quote_draft($1, 1, $2, $3, '[]', '{}')",
        [
          quoteId,
          randomUUID(),
          JSON.stringify({
            customer_id: w.customerA,
            global_discount: { kind: "none", value: 0 },
            exclusions: "x",
          }),
        ],
      );
      expect(error.message).toBe("unknown_header_key");
    }));
});
