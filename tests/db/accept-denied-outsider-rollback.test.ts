// H-009/H-010 · decisión de Aarón en el PR #35 (2026-11-09), construida en el PR #36 · migración 20261109110000_accept_denied_outsider_anonymous.
// Una sola función cambia: `app.invitation_audit_wrong_email` deja de guardar el id, la IP, el navegador y la correlación
// de alguien de FUERA de la organización en el registro de esa organización (y escribe la copia completa en la
// organización «plataforma»). Aquí se prueba que el «deshacer» la devuelve EXACTAMENTE a su texto anterior (lenguaje
// `sql`, mismos permisos), que con el deshacer el id de alguien de fuera VUELVE a quedar en el registro (por eso la
// migración hace falta), que la migración se puede volver a aplicar y que `accept_invitation` es la misma en los dos
// sentidos y que el deshacer se NIEGA a correr si la función vigente ya no es la de esta migración (por ejemplo, si no se
// deshizo antes 20261109130000). Se ejecutan los archivos reales dentro de una transacción que se deshace; el deshacer completo y en orden lo
// prueba `npm run test:db:rollbacks`. Todo es ficticio.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationEmailBinding } from "../../src/lib/team/invitation-code";
import {
  actAs,
  actAsPostgres,
  connect,
  createUser,
  expectSqlError,
  withTx,
  type TestUser,
} from "./helpers";
import { functionBodyIn } from "./migration-files";
import { asUser, buildWorld, newToken, sha256Hex, type World } from "./send-helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const NAME = "20261109110000_accept_denied_outsider_anonymous";
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
const acceptMigration = read("migrations", "20261103100000_invitation_accept.sql");
// Desde 20261109130000 la ayuda la vuelve a redefinir otra migración (quien fue quitado ya no entrega su IP). Para probar
// ESTA migración, la definición vigente tiene que ser la suya: se deshace primero lo más nuevo.
const downNewest = read("rollbacks", "20261109130000_invitation_audit_active_only.down.sql");

const AUDIT_SIG = "app.invitation_audit_wrong_email(public.invitations, uuid, text)";
const ACCEPT_SIG = "public.accept_invitation(text)";

/** Lo que hay entre los `$$` de una función en una migración (tal como lo guarda `pg_proc.prosrc`). */
function bodyIn(sql: string, signature: string): string {
  const start = sql.indexOf(`function ${signature.split("(")[0]}(`);
  expect(start, `no encontré ${signature}`).toBeGreaterThan(-1);
  const open = sql.indexOf("$$", start) + 2;
  return sql.slice(open, sql.indexOf("$$", open));
}

let db: Client;
let w: World;
beforeAll(async () => {
  db = await connect();
  w = await buildWorld(db);
});
afterAll(async () => {
  await db.end();
});

type Definition = {
  src: string;
  lang: string;
  secdef: boolean;
  cfg: string[] | null;
  args: string;
  returns: string;
  volatility: string;
  anon: boolean;
  pub: boolean;
  auth: boolean;
};
const definition = async (signature: string): Promise<Definition> =>
  (
    await db.query<Definition>(
      `select p.prosrc as src, l.lanname as lang, p.prosecdef as secdef, p.proconfig as cfg,
              pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as returns,
              p.provolatile as volatility,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('public', p.oid, 'execute') as pub,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = $1::regprocedure`,
      [signature],
    )
  ).rows[0];

const withoutSrc = (definition: Definition) => {
  const copy: Partial<Definition> = { ...definition };
  delete copy.src;
  delete copy.lang;
  return copy;
};

/** Una invitación de A para `email` y un intento de aceptarla hecho por `user` (con IP y navegador). */
async function attempt(user: TestUser, email: string) {
  const id = randomUUID();
  const { sha } = newToken();
  const mailId = randomUUID();
  await asUser(db, w.owner, w.tenantA);
  await db.query("select public.create_invitation($1, $2, $3, $4, $5, $6, $7, $8)", [
    id,
    `v1.cifrado.${id}`,
    sha256Hex(`huella|${email}`),
    invitationEmailBinding(sha, email),
    sha,
    "viewer",
    mailId,
    `v1.cifrado.correo.${mailId}`,
  ]);
  await actAs(db, user, { "x-cp-client-ip": "203.0.113.7", "user-agent": "Prueba/1.0" });
  const { rows } = await db.query<{ r: { result: string } }>(
    "select public.accept_invitation($1) as r",
    [sha],
  );
  await actAsPostgres(db);
  expect(rows[0].r).toEqual({ result: "wrong_email" });
  return id;
}
const orgRows = async (invitationId: string) => {
  await actAsPostgres(db);
  return (
    await db.query<{ actor_user_id: string | null; ip: string | null; user_agent: string | null }>(
      `select actor_user_id, host(origin_ip) as ip, user_agent from public.audit_log
        where action = 'invitation.accept_denied' and tenant_id = $1 and resource_id = $2`,
      [w.tenantA, invitationId],
    )
  ).rows;
};
const platformCount = async (invitationId: string) => {
  await actAsPostgres(db);
  return Number(
    (
      await db.query<{ n: string }>(
        `select count(*) as n from public.audit_log
          where action = 'invitation.accept_denied' and tenant_id = app.platform_tenant_id() and resource_id = $1`,
        [invitationId],
      )
    ).rows[0].n,
  );
};

describe("el deshacer de accept_denied_outsider_anonymous", () => {
  it("AD1 · solo redefine la ayuda (sin ningún drop) y la migración no toca accept_invitation ni invitation_state", () => {
    const code = (sql: string) =>
      sql
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");
    expect(code(down)).toContain("create or replace function app.invitation_audit_wrong_email(");
    expect(code(up)).toContain("create or replace function app.invitation_audit_wrong_email(");
    expect(code(down)).not.toMatch(/\bdrop\b/i);
    expect(code(down)).not.toMatch(/\b(truncate|alter\s+table|delete\s+from|update\s+public)\b/i);
    expect(code(up)).not.toMatch(
      /\b(drop|truncate|alter\s+table|delete\s+from|update\s+public)\b/i,
    );
    for (const untouched of ["public.accept_invitation", "app.invitation_state"]) {
      expect(code(up), untouched).not.toMatch(new RegExp(`function\\s+${untouched}\\b`));
      expect(code(down), untouched).not.toMatch(new RegExp(`function\\s+${untouched}\\b`));
    }
  });

  it("AD2 · la definición vigente es la de esta migración (plpgsql); tras el deshacer, la de 20261103100000 (sql); mismos atributos y permisos", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(downNewest);
      const current = await definition(AUDIT_SIG);
      expect(current.src.trim()).toBe(bodyIn(up, AUDIT_SIG).trim());
      expect(current.lang).toBe("plpgsql");

      await db.query(down);

      const restored = await definition(AUDIT_SIG);
      expect(restored.src).toBe(bodyIn(acceptMigration, AUDIT_SIG));
      expect(restored.lang).toBe("sql");
      expect(withoutSrc(restored)).toEqual(withoutSrc(current));
      expect(restored).toMatchObject({
        secdef: true,
        volatility: "v",
        anon: false,
        pub: false,
        auth: false,
      });
      expect(restored.cfg).toContain('search_path=""');
    }));

  it("AD3 · con la migración, alguien de fuera no deja su id en la organización; tras el deshacer, VUELVE a dejarlo; al reaplicar, otra vez no", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(downNewest);
      const outsider = await createUser(db);
      const person = await createUser(db);
      const insider = w.sales;

      const withMigration = await attempt(outsider, person.email);
      expect(await orgRows(withMigration)).toEqual([
        { actor_user_id: null, ip: null, user_agent: null },
      ]);
      expect(await platformCount(withMigration)).toBe(1);

      await db.query(down);

      const afterDown = await attempt(outsider, `otro-${person.email}`);
      const rows = await orgRows(afterDown);
      expect(rows).toEqual([
        { actor_user_id: outsider.id, ip: "203.0.113.7", user_agent: "Prueba/1.0" },
      ]);
      // El deshacer no escribe la copia de la plataforma: solo la escribe la versión nueva.
      expect(await platformCount(afterDown)).toBe(0);
      // Quien es de la organización queda igual con las dos versiones.
      const insiderAfterDown = await attempt(insider, `tercero-${person.email}`);
      expect((await orgRows(insiderAfterDown))[0].actor_user_id).toBe(insider.id);
      // Lo escrito antes (sin autor) no se toca ni se borra.
      expect(await orgRows(withMigration)).toHaveLength(1);

      await db.query(up);

      const again = await attempt(outsider, `cuarto-${person.email}`);
      expect(await orgRows(again)).toEqual([{ actor_user_id: null, ip: null, user_agent: null }]);
      expect(await platformCount(again)).toBe(1);
      const insiderAgain = await attempt(insider, `quinto-${person.email}`);
      expect((await orgRows(insiderAgain))[0].actor_user_id).toBe(insider.id);
    }));

  it("AD4 · `accept_invitation` es la misma con la migración y tras el deshacer", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(downNewest);
      const before = await definition(ACCEPT_SIG);
      await db.query(down);
      expect(await definition(ACCEPT_SIG)).toEqual(before);
      await db.query(up);
      expect(await definition(ACCEPT_SIG)).toEqual(before);
    }));

  it("AD5 · el deshacer se niega a correr si la función vigente no es la de esta migración (md5 del cuerpo): sin deshacer antes 20261109130000, con el deshacer ya corrido o con una función editada; en el orden correcto pasa", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const refusal =
        "la funcion app.invitation_audit_wrong_email vigente ya no es la de esta migracion";
      // El md5 escrito en el deshacer es el del cuerpo de la función de la migración (se recalcula del archivo).
      const written = /md5\(p\.prosrc\) = '([0-9a-f]{32})'/.exec(down)?.[1];
      expect(written, "el deshacer compara el md5 del cuerpo").toBeDefined();
      expect(written).toBe(
        createHash("md5")
          .update(functionBodyIn(up, "app.invitation_audit_wrong_email"))
          .digest("hex"),
      );
      // (a) Fuera de orden: la vigente es la de 20261109130000 (solo quien tuvo fila activa deja su id). Se niega y no cambia nada.
      const newest = await definition(AUDIT_SIG);
      expect(newest.lang).toBe("plpgsql");
      const early = await expectSqlError(db, down);
      expect(early.message).toContain(refusal);
      expect(early.message).toContain("revise el orden de los deshacer");
      expect(await definition(AUDIT_SIG)).toEqual(newest);
      // (b) En orden: primero lo más nuevo y luego este; pasa y deja la función original (lenguaje sql).
      await db.query(downNewest);
      expect((await definition(AUDIT_SIG)).src.trim()).toBe(bodyIn(up, AUDIT_SIG).trim());
      await db.query(down);
      expect((await definition(AUDIT_SIG)).lang).toBe("sql");
      // (c) Repetirlo con la original puesta (ya se deshizo) también se niega.
      const again = await expectSqlError(db, down);
      expect(again.message).toContain(refusal);
      expect((await definition(AUDIT_SIG)).lang).toBe("sql");
      // (d) Una función de esta migración editada por otra (otro cuerpo, mismo lenguaje) se niega; con la original, pasa.
      await db.query(up);
      const def = (
        await db.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) as d", [
          AUDIT_SIG,
        ])
      ).rows[0].d;
      expect(def).toContain("\nbegin\n");
      await db.query(def.replace("\nbegin\n", "\nbegin\n  -- editada por otra migracion\n"));
      const edited = await expectSqlError(db, down);
      expect(edited.message).toContain(refusal);
      expect((await definition(AUDIT_SIG)).src).toContain("editada por otra migracion");
      await db.query(def);
      await db.query(down);
      expect((await definition(AUDIT_SIG)).lang).toBe("sql");
    }));
});
