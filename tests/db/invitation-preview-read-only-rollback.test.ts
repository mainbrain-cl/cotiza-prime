// H-009 · corrección I1 · El «deshacer» de `invitation_preview_read_only` deja la función exactamente como la dejó
// `20261103100000_invitation_accept.sql` (la que cuenta fallos y audita), con la misma firma y los mismos permisos,
// y la migración se puede volver a aplicar. Se ejecutan los archivos reales dentro de una transacción que se
// deshace; el deshacer completo y en orden lo prueba `npm run test:db:rollbacks`.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, withTx } from "./helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const NAME = "20261105100000_invitation_preview_read_only";
const OLD = "20261103100000_invitation_accept";
const up = readFileSync(path.join(ROOT, "migrations", `${NAME}.sql`), "utf8");
const down = readFileSync(path.join(ROOT, "rollbacks", `${NAME}.down.sql`), "utf8");
const oldMigration = readFileSync(path.join(ROOT, "migrations", `${OLD}.sql`), "utf8");

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

/** El cuerpo (lo que hay entre los `$$`) de `invitation_preview` en una migración. */
function bodyIn(sql: string): string {
  const start = sql.indexOf("function public.invitation_preview(");
  expect(start, "no encontré la función").toBeGreaterThan(-1);
  const open = sql.indexOf("$$", start) + 2;
  const close = sql.indexOf("end $$;", open);
  return sql.slice(open, close) + "end ";
}

type Definition = {
  count: number;
  src: string;
  secdef: boolean;
  cfg: string[] | null;
  args: string;
  returns: string;
  anon: boolean;
  pub: boolean;
  auth: boolean;
  volatility: string;
};
async function definition(): Promise<Definition> {
  const { rows } = await db.query<Definition>(
    `select (select count(*)::int from pg_proc q join pg_namespace s on s.oid = q.pronamespace
              where s.nspname = 'public' and q.proname = 'invitation_preview') as count,
            p.prosrc as src, p.prosecdef as secdef, p.proconfig as cfg,
            pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as returns,
            has_function_privilege('anon', p.oid, 'execute') as anon,
            has_function_privilege('public', p.oid, 'execute') as pub,
            has_function_privilege('authenticated', p.oid, 'execute') as auth,
            p.provolatile as volatility
       from pg_proc p where p.oid = 'public.invitation_preview(text)'::regprocedure`,
  );
  return rows[0];
}

describe("el deshacer de invitation_preview_read_only", () => {
  it("deja la función con la definición de 20261103100000: misma firma, mismos permisos, una sola función", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const current = await definition();
      expect(current.count).toBe(1);
      // La versión actual (solo lectura) no cuenta fallos ni audita.
      expect(current.src).not.toContain("invitation_accept_fail");
      expect(current.src).not.toContain("write_audit");

      await db.query(down);
      const restored = await definition();
      expect(restored.count).toBe(1);
      expect(restored.src.trim()).toBe(bodyIn(oldMigration).trim());
      expect(restored.src).toContain("invitation_accept_fail(v_uid)");
      expect(restored.src).toContain("invitation_audit_wrong_email(v_inv, v_uid, 'preview')");
      expect(restored.src).toContain("pg_advisory_xact_lock");
      for (const key of [
        "secdef",
        "cfg",
        "args",
        "returns",
        "anon",
        "pub",
        "auth",
        "volatility",
      ] as const) {
        expect(restored[key], key).toEqual(current[key]);
      }
    }));

  it("la migración se puede volver a aplicar después de deshacerla y deja la versión de solo lectura", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const original = await definition();
      await db.query(down);
      await db.query(up);
      const again = await definition();
      expect(again).toEqual(original);
      expect(again.src.trim()).toBe(bodyIn(up).trim());
    }));
});
