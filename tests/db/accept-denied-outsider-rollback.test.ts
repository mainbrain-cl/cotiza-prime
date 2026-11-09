// H-009/H-010 · decisión de Aarón en el PR #33 (2026-11-09) · migración 20261109110000_accept_denied_outsider_anonymous.
// Una sola función cambia: `app.invitation_audit_wrong_email` deja de guardar el id, la IP, el navegador y la correlación
// de alguien de FUERA de la organización en el registro de esa organización (y escribe la copia completa en la
// organización «plataforma»). Aquí se prueba que el «deshacer» la devuelve EXACTAMENTE a su texto anterior (lenguaje
// `sql`, mismos permisos), que con el deshacer el id de alguien de fuera VUELVE a quedar en el registro (por eso la
// migración hace falta), que la migración se puede volver a aplicar y que `accept_invitation` es la misma en los dos
// sentidos. Se ejecutan los archivos reales dentro de una transacción que se deshace; el deshacer completo y en orden lo
// prueba `npm run test:db:rollbacks`. Todo es ficticio.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationEmailBinding } from "../../src/lib/team/invitation-code";
import { actAs, actAsPostgres, connect, createUser, withTx, type TestUser } from "./helpers";
import { asUser, buildWorld, newToken, sha256Hex, type World } from "./send-helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const NAME = "20261109110000_accept_denied_outsider_anonymous";
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
const acceptMigration = read("migrations", "20261103100000_invitation_accept.sql");

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
      const before = await definition(ACCEPT_SIG);
      await db.query(down);
      expect(await definition(ACCEPT_SIG)).toEqual(before);
      await db.query(up);
      expect(await definition(ACCEPT_SIG)).toEqual(before);
    }));
});
