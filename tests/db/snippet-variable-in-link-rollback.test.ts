// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Menores de la revisión de Aarón al PR #67, punto 1 · migración 20261124100000_snippet_variable_in_link y su deshacer: `lock_timeout` y su
// verificador, que define solo `app.snippet_variables_problem` sin cambiar permisos, que el deshacer devuelve la función EXACTAMENTE a la de
// H-048a, que se puede volver a aplicar y que se NIEGA a correr (sin cambiar nada) si la función vigente ya no es la de la migración.
// Se ejecutan los archivos reales dentro de una transacción que se deshace: no queda nada. El deshacer completo y en orden lo prueba
// `npm run test:db:rollbacks`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import { functionBodyIn } from "./migration-files";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const NAME = "20261124100000_snippet_variable_in_link";
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
const previous = read("migrations", "20261104110000_text_snippets.sql");
const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const code = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

const FN = "app.snippet_variables_problem(text, text)";
const LINK_TEXT = "[Mira]({{cliente}})";

let db: Client;
beforeAll(async () => {
  db = await connect();
});
afterAll(async () => {
  await db.end();
});

const definition = async () =>
  (
    await db.query(
      `select p.prosrc as src, p.provolatile as volatility, p.proconfig as cfg, p.prosecdef as secdef,
              pg_get_function_result(p.oid) as returns, pg_get_function_arguments(p.oid) as args,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p where p.oid = $1::regprocedure`,
      [FN],
    )
  ).rows[0];
const problem = async (kind: string, body: string) =>
  (
    await db.query<{ p: string | null }>("select app.snippet_variables_problem($1, $2) as p", [
      kind,
      body,
    ])
  ).rows[0].p;

describe("la migración snippet_variable_in_link y su deshacer", () => {
  it("SV1 · los dos archivos empiezan con `lock_timeout` de 3 s y su verificador; solo se redefine `app.snippet_variables_problem`", () => {
    for (const sql of [up, down]) {
      const [first, ...rest] = code(sql).split(";");
      expect(first.replace(/\s+/g, " ").trim()).toBe("set local lock_timeout = '3s'");
      expect(rest.join(";").trimStart()).toMatch(
        /^do \$\$ begin\s+if current_setting\('lock_timeout'\) <> '3s' then\s+raise exception [\s\S]*?;\s+end if;/i,
      );
    }
    const defined = [...code(up).matchAll(/create (?:or replace )?function ([a-z_.]+)\(/gi)].map(
      (m) => m[1],
    );
    expect(defined).toEqual(["app.snippet_variables_problem"]);
    // ni permisos ni tablas ni disparadores
    expect(code(up)).not.toMatch(/\bgrant\b|\brevoke\b|create table|alter table|create trigger/i);
  });

  it("SV2 · el md5 que exige el deshacer es el del cuerpo de la migración, y coincide con la base", async () => {
    const body = functionBodyIn(up, "app.snippet_variables_problem");
    expect(code(down)).toContain(`md5(p.prosrc) = '${md5(body)}'`);
    await actAsPostgres(db);
    expect((await definition()).src).toBe(body);
  });

  it("SV3 · la función nueva solo suma la regla del enlace: quitada, queda idéntica a la de H-048a", () => {
    const before = functionBodyIn(previous, "app.snippet_variables_problem");
    const after = functionBodyIn(up, "app.snippet_variables_problem");
    const stripped = after.replace(
      /  -- Una variable dentro de la dirección[\s\S]*?return 'variable_in_link';\n {2}end if;\n/,
      "",
    );
    expect(stripped).toBe(before);
  });

  it("SV4 · rechaza una variable dentro de la dirección de un enlace, solo en el texto del correo; lo demás sigue igual", async () => {
    await actAsPostgres(db);
    expect(await problem("email_body", LINK_TEXT)).toBe("variable_in_link");
    expect(await problem("email_body", "[Mira](https://{{organizacion}}/x)")).toBe(
      "variable_in_link",
    );
    expect(
      await problem("email_body", "[{{cliente}}](https://ejemplo.cl/x) {{numero}}"),
    ).toBeNull();
    expect(await problem("email_body", "Hola ({{cliente}})")).toBeNull();
    // los demás tipos no admiten variables, con su motivo de siempre
    expect(await problem("conditions", LINK_TEXT)).toBe("variables_not_allowed");
    // el orden: una variable que no existe se dice antes que el enlace
    expect(await problem("email_body", "[Mira]({{otra}})")).toBe("unknown_variable");
  });

  it("SV5 · el deshacer devuelve la función EXACTAMENTE a la de H-048a, con sus atributos y permisos; se puede volver a aplicar", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const current = await definition();
      await db.query(down);
      const restored = await definition();
      expect(restored.src).toBe(functionBodyIn(previous, "app.snippet_variables_problem"));
      expect({ ...restored, src: "" }).toEqual({ ...current, src: "" });
      expect(restored).toMatchObject({ anon: false, auth: false, secdef: false, volatility: "i" });
      expect(await problem("email_body", LINK_TEXT)).toBeNull();
      await db.query(up);
      expect((await definition()).src).toBe(current.src);
      expect(await problem("email_body", LINK_TEXT)).toBe("variable_in_link");
    }));

  it("SV6 · el deshacer se NIEGA a correr dos veces y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(down);
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/ya no es la de esta migracion/);
      expect((await definition()).src).toBe(
        functionBodyIn(previous, "app.snippet_variables_problem"),
      );
    }));

  it("SV7 · si OTRA migración redefinió la función, se NIEGA y no la pisa", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const body = functionBodyIn(up, "app.snippet_variables_problem");
      await db.query(
        `create or replace function app.snippet_variables_problem(p_kind text, p_body text) returns text
           language plpgsql immutable set search_path = '' as $f$${body}\n-- redefinida por otra historia\n$f$`,
      );
      const before = await definition();
      const error = await expectSqlError(db, down);
      expect(error.message).toMatch(/ya no es la de esta migracion/);
      expect((await definition()).src).toBe(before.src);
    }));
});
