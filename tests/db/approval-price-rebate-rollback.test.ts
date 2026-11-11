// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · migración 20261111100000_approval_price_rebate (decisión de Aarón, 2026-11-11: bajar el precio a mano cuenta como
// descuento). Redefine solo `app.quote_approval_check`. Aquí: que el archivo y su deshacer empiezan con `lock_timeout` y su
// verificador, que el deshacer devuelve la función EXACTAMENTE a su texto anterior (con los mismos atributos y permisos), que se
// puede volver a aplicar, que se niega a correr dos veces, y que el cambio se nota (con la rebaja se pide aprobación; sin ella, no).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import { addCatalogItem, createQuoteWith } from "./approval-helpers";
import { functionBodyIn } from "./migration-files";
import { buildWorld, type World } from "./send-helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const NAME = "20261111100000_approval_price_rebate";
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
const previous = read("migrations", "20261110110000_approval_rules.sql");
const SIGNATURE = "app.quote_approval_check(uuid, uuid)";

const code = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

let db: Client;
let w: World;
beforeAll(async () => {
  db = await connect();
  w = await buildWorld(db);
});
afterAll(async () => {
  await db.end();
});

const definition = async () =>
  (
    await db.query(
      `select p.prosrc as src, p.prosecdef as secdef, p.proconfig as cfg, p.provolatile as volatility,
              pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as returns,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p where p.oid = $1::regprocedure`,
      [SIGNATURE],
    )
  ).rows[0];

describe("la migración approval_price_rebate y su deshacer", () => {
  it("PR1 · los dos archivos empiezan con `lock_timeout` de 3 s y su verificador, y solo redefinen la función", () => {
    for (const sql of [up, down]) {
      const [first, ...rest] = code(sql).split(";");
      expect(first.replace(/\s+/g, " ").trim()).toBe("set local lock_timeout = '3s'");
      expect(rest.join(";").trimStart()).toMatch(
        /^do \$\$ begin\s+if current_setting\('lock_timeout'\) <> '3s' then\s+raise exception [\s\S]*?;\s+end if;/i,
      );
      const defined = [...code(sql).matchAll(/create (?:or replace )?function ([a-z_.]+)\(/gi)].map(
        (m) => m[1],
      );
      expect(defined).toEqual(["app.quote_approval_check"]);
      expect(code(sql)).toMatch(
        /revoke all on function app\.quote_approval_check\(uuid, uuid\)\s+from public, anon, authenticated;/,
      );
      expect(code(sql)).not.toMatch(/\b(drop|truncate|delete\s+from|alter\s+table)\b/i);
    }
  });

  it("PR2 · la función vigente es la del archivo; tras el deshacer es EXACTAMENTE la de 20261110110000, con los mismos atributos y permisos", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const current = await definition();
      expect(current.src).toBe(functionBodyIn(up, "app.quote_approval_check"));
      expect(current.src).toContain("price_rebate_clp");

      await db.query(down);
      const restored = await definition();
      expect(restored.src).toBe(functionBodyIn(previous, "app.quote_approval_check"));
      expect(restored.src).not.toContain("price_rebate_clp");
      expect({ ...restored, src: "" }).toEqual({ ...current, src: "" });
      expect(restored).toMatchObject({ secdef: true, anon: false, auth: false });
      expect(restored.cfg).toContain('search_path=""');

      // volver a aplicarla deja lo mismo
      await db.query(up);
      expect((await definition()).src).toBe(current.src);
    }));

  it("PR3 · el deshacer se NIEGA a correr dos veces (la función ya no nombra la rebaja) y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(down);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/ya no nombra la rebaja de precio/);
      expect((await definition()).src).toBe(functionBodyIn(previous, "app.quote_approval_check"));
    }));

  it("PR4 · con el deshacer, un precio bajado a mano deja de contar; con la migración, cuenta", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const catalogItemId = await addCatalogItem(db, w.tenantA, 100_000);
      const { quoteId } = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, {
        lines: [{ price: 80_000, catalogItemId }],
      });
      await actAsPostgres(db);
      const metrics = async () =>
        (
          await db.query("select app.quote_approval_check($1, $2) -> 'metrics' as m", [
            w.tenantA,
            quoteId,
          ])
        ).rows[0].m;
      expect(await metrics()).toMatchObject({
        price_rebate_clp: 20_000,
        discount_clp: 20_000,
        discount_bp: 2_000,
      });
      await db.query(down);
      expect(await metrics()).toEqual({ total_clp: 95_200, discount_clp: 0, discount_bp: 0 });
    }));
});
