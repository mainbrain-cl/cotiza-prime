// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · migraciones 20261110110000_approval_rules (H-040a) y 20261110120000_approval_send_gate (H-040b) y sus deshacer.
// Aquí se prueba, ejecutando los archivos reales dentro de una transacción que se deshace: que cada archivo empieza con
// `lock_timeout` de 3 s, que el deshacer de cada migración quita lo suyo y nada más, que se pueden volver a aplicar, y que los
// dos deshacer SE NIEGAN a correr si borrarían la prueba de qué regla regía un envío (versiones creadas por personas). El
// deshacer completo y en orden de TODAS las migraciones lo prueba `npm run test:db:rollbacks`.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import { createQuoteWith, prepareArgs, prepareIds, PREPARE_SQL } from "./approval-helpers";
import { asUser, buildWorld, type World } from "./send-helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const A = "20261110110000_approval_rules";
const B = "20261110120000_approval_send_gate";
const upA = read("migrations", `${A}.sql`);
const upB = read("migrations", `${B}.sql`);
const downA = read("rollbacks", `${A}.down.sql`);
const downB = read("rollbacks", `${B}.down.sql`);
const upC = read("migrations", "20261111100000_approval_price_rebate.sql");
const downC = read("rollbacks", "20261111100000_approval_price_rebate.down.sql");

const code = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
const firstStatement = (sql: string) => code(sql).replace(/\s+/g, " ").trim().split(";")[0].trim();

let db: Client;
let w: World;
beforeAll(async () => {
  db = await connect();
  w = await buildWorld(db);
});
afterAll(async () => {
  await db.end();
});

const exists = async (sql: string): Promise<boolean> => (await db.query(sql)).rowCount === 1;
const tableExists = () =>
  exists("select 1 from pg_class where oid = to_regclass('public.approval_rules')");
const columnExists = () =>
  exists(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'quote_packages' and column_name = 'approval_rule_id'`,
  );
const functionsLeft = async (): Promise<string[]> =>
  (
    await db.query<{ name: string }>(
      `select n.nspname || '.' || p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where (n.nspname = 'public' and p.proname = 'set_approval_rule')
           or (n.nspname = 'app' and (p.proname like 'approval\\_%' or p.proname = 'quote_approval_check'
                or p.proname in ('tenants_create_default_approval_rule', 'quote_packages_approval_gate')))
        order by 1`,
    )
  ).rows.map((r) => r.name);

/** Borra las versiones creadas por personas que otras pruebas dejaron confirmadas (solo dentro de la transacción). */
async function clearPersonVersions() {
  await actAsPostgres(db);
  await db.query("set local session_replication_role = replica");
  await db.query("delete from public.approval_rules where created_by is not null");
  await db.query("set local session_replication_role = origin");
}

describe("los archivos", () => {
  it("AR1 · `lock_timeout` de 3 s es la primera sentencia de las dos migraciones y de los dos deshacer", () => {
    for (const sql of [upA, upB, upC, downA, downB, downC]) {
      expect(firstStatement(sql)).toBe("set local lock_timeout = '3s'");
    }
    // `lock_timeout` aparece una sola vez por archivo (y en el verificador de la migración), sin begin/commit.
    for (const sql of [upA, upB, upC, downA, downB, downC]) {
      expect(code(sql).match(/set\s+local\s+lock_timeout/gi)).toHaveLength(1);
      expect(code(sql)).not.toMatch(/^\s*(begin|commit)\s*;/im);
    }
    // Desde 20261109130000 (PR #38) también los deshacer traen, como segunda sentencia, el verificador de `lock_timeout`.
    for (const sql of [upA, upB, upC, downA, downB, downC]) {
      const second = code(sql).split(";").slice(1).join(";").trimStart();
      expect(second).toMatch(
        /^do \$\$ begin\s+if current_setting\('lock_timeout'\) <> '3s' then\s+raise exception [\s\S]*?;\s+end if;/i,
      );
    }
  });

  it("AR2 · toda función de las migraciones que corre con permisos elevados fija `search_path` y usa nombres con esquema", () => {
    for (const sql of [upA, upB]) {
      const defs = [...code(sql).matchAll(/create function ([a-z_.]+)\([\s\S]*?\$\$;?/gi)];
      expect(defs.length).toBeGreaterThan(0);
      for (const def of defs) {
        if (/security definer/i.test(def[0]))
          expect(def[0], def[1]).toMatch(/set search_path = ''/);
      }
    }
  });
});

describe("el deshacer de H-040b (el control en el envío)", () => {
  it("AR3 · quita el disparador, su función y la columna, y nada más; el envío vuelve a pasar sin mirar la regla", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await clearPersonVersions();
      expect(await columnExists()).toBe(true);
      await db.query(downB);
      expect(await columnExists()).toBe(false);
      expect(
        await exists(
          "select 1 from pg_trigger where tgname = 'quote_packages_approval_gate' and not tgisinternal",
        ),
      ).toBe(false);
      expect(await functionsLeft()).not.toContain("app.quote_packages_approval_gate");
      // La tabla de la regla y su función de cambio siguen (son de H-040a).
      expect(await tableExists()).toBe(true);
      expect(await functionsLeft()).toContain("public.set_approval_rule");

      // Con «Siempre» y sin el control, el envío pasa: ya nada lo mira.
      await actAsPostgres(db);
      await db.query(
        `insert into public.approval_rules (tenant_id, version, mode, created_by)
         select $1, coalesce(max(version), 0) + 1, 'always', $2 from public.approval_rules where tenant_id = $1`,
        [w.tenantA, w.owner.id],
      );
      const quote = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, {
        lines: [{ price: 10_000 }],
      });
      await asUser(db, w.sales, w.tenantA);
      const { rows } = await db.query<{ r: { status: string } }>(
        PREPARE_SQL,
        prepareArgs(quote.quoteId, quote.revision, prepareIds()),
      );
      expect(rows[0].r.status).toBe("prepared");
    }));

  it("AR4 · se puede volver a aplicar y el control vuelve a funcionar; los paquetes ya existentes quedan con la versión 1", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await clearPersonVersions();
      await db.query(downB);
      await db.query(upB);
      expect(await columnExists()).toBe(true);
      const { rows } = await db.query<{ nulls: number }>(
        "select count(*) filter (where approval_rule_id is null)::int as nulls from public.quote_packages",
      );
      expect(rows[0].nulls).toBe(0);
      const versions = await db.query<{ v: number }>(
        `select distinct r.version as v from public.quote_packages p
           join public.approval_rules r on r.tenant_id = p.tenant_id and r.id = p.approval_rule_id`,
      );
      expect(versions.rows.map((r) => r.v)).toEqual([1]);

      await db.query(
        `insert into public.approval_rules (tenant_id, version, mode, created_by)
         select $1, coalesce(max(version), 0) + 1, 'always', $2 from public.approval_rules where tenant_id = $1`,
        [w.tenantA, w.owner.id],
      );
      const quote = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, {
        lines: [{ price: 10_000 }],
      });
      await asUser(db, w.sales, w.tenantA);
      const error = await expectSqlError(
        db,
        PREPARE_SQL,
        prepareArgs(quote.quoteId, quote.revision, prepareIds()),
      );
      expect(error.message).toBe("approval_required");
    }));

  it("AR5 · se NIEGA si un envío apunta a una versión de la regla creada por una persona", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await clearPersonVersions();
      // Una versión de una persona y un paquete que la usa (montaje como postgres).
      await db.query(
        `insert into public.approval_rules (tenant_id, version, mode, amount_threshold_clp, created_by)
         select $1, coalesce(max(version), 0) + 1, 'conditional', 9000000, $2 from public.approval_rules where tenant_id = $1`,
        [w.tenantA, w.owner.id],
      );
      const quote = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, {
        lines: [{ price: 10_000 }],
      });
      const { ids } = await (async () => {
        const i = prepareIds();
        await asUser(db, w.sales, w.tenantA);
        await db.query(PREPARE_SQL, prepareArgs(quote.quoteId, quote.revision, i));
        await actAsPostgres(db);
        return { ids: i };
      })();
      const { rows } = await db.query(
        `select r.created_by is not null as by_person from public.quote_packages p
           join public.approval_rules r on r.tenant_id = p.tenant_id and r.id = p.approval_rule_id where p.id = $1`,
        [ids.packageId],
      );
      expect(rows[0].by_person).toBe(true);
      const error = await expectSqlError(db, downB);
      expect(error.message).toMatch(/no se puede deshacer 20261110120000_approval_send_gate/);
      expect(await columnExists()).toBe(true);
    }));
});

describe("el deshacer de H-040a (la regla)", () => {
  it("AR6 · se NIEGA mientras exista la rebaja de precio (20261111100000) y mientras exista la columna del paquete: el orden es 3, 2 y 1", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await clearPersonVersions();
      const rebate = await expectSqlError(db, downA);
      expect(rebate.message).toMatch(/deshaga primero 20261111100000_approval_price_rebate/);
      await db.query(downC);
      const column = await expectSqlError(db, downA);
      expect(column.message).toMatch(/deshaga antes 20261110120000_approval_send_gate/);
      expect(await tableExists()).toBe(true);
    }));

  it("AR7 · se NIEGA si hay versiones creadas por personas, y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await clearPersonVersions();
      await db.query(downC);
      await db.query(downB);
      await db.query(
        `insert into public.approval_rules (tenant_id, version, mode, created_by)
         select $1, coalesce(max(version), 0) + 1, 'always', $2 from public.approval_rules where tenant_id = $1`,
        [w.tenantA, w.owner.id],
      );
      const before = (await db.query("select count(*)::int as n from public.approval_rules"))
        .rows[0].n;
      const error = await expectSqlError(db, downA);
      expect(error.message).toMatch(/hay versiones de la regla creadas por personas/);
      expect(await tableExists()).toBe(true);
      expect(
        (await db.query("select count(*)::int as n from public.approval_rules")).rows[0].n,
      ).toBe(before);
    }));

  it("AR8 · sin versiones de personas, quita la tabla, el disparador de organizaciones y todas las funciones; y se puede volver a aplicar", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await clearPersonVersions();
      await db.query(downC);
      await db.query(downB);
      await db.query(downA);
      expect(await tableExists()).toBe(false);
      expect(await functionsLeft()).toEqual([]);
      expect(
        await exists(
          "select 1 from pg_trigger where tgname = 'tenants_default_approval_rule' and not tgisinternal",
        ),
      ).toBe(false);
      // Crear una organización ya no deja regla alguna.
      await expectSqlError(db, "select * from public.approval_rules");

      await db.query(upA);
      await db.query(upB);
      await db.query(upC);
      expect(await tableExists()).toBe(true);
      expect((await functionsLeft()).length).toBeGreaterThanOrEqual(10);
      // Toda organización vuelve a tener su versión 1 «Nunca», y los paquetes ya existentes apuntan a ella.
      const { rows } = await db.query(
        `select count(*) filter (where r.id is null)::int as missing from public.tenants t
           left join public.approval_rules r on r.tenant_id = t.tenant_id and r.version = 1
          where t.kind = 'organization'`,
      );
      expect(rows[0].missing).toBe(0);
    }));
});
