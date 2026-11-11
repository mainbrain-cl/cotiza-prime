// H-009/H-010 · menor 1 de la revisión de Aarón al PR #36 (2026-11-10) · migración 20261109130000_invitation_audit_active_only.
// Una sola función cambia: `app.invitation_audit_wrong_email` conserva SIEMPRE el id de quien tiene o tuvo una fila en
// `members` de la organización de la invitación, pero su IP, su navegador y su correlación solo si hoy es miembro ACTIVO.
// Aquí se prueba que el «deshacer» la devuelve EXACTAMENTE a su texto anterior (el de 20261109110000), que la migración se
// puede volver a aplicar, que `accept_invitation` es la misma en los dos sentidos, que la copia de la plataforma no cambia
// y que la verificación de `lock_timeout` detiene el archivo si el valor no quedó puesto. Se ejecutan los archivos reales
// dentro de una transacción que se deshace; el deshacer completo y en orden lo prueba `npm run test:db:rollbacks`. Todo es
// ficticio.
import { randomUUID } from "node:crypto";
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
const NAME = "20261109130000_invitation_audit_active_only";
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
/** La migración anterior que define la ayuda: a su texto vuelve el deshacer. */
const previous = read("migrations", "20261109110000_accept_denied_outsider_anonymous.sql");

const AUDIT_SIG = "app.invitation_audit_wrong_email(public.invitations, uuid, text)";
const ACCEPT_SIG = "public.accept_invitation(text)";
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
         from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = to_regprocedure($1)`,
      [signature],
    )
  ).rows[0];
const withoutSrc = (definition: Definition) => {
  const copy: Partial<Definition> = { ...definition };
  delete copy.src;
  return copy;
};

/** Una invitación de A para `email` y un intento de aceptarla hecho por `user` (con IP, navegador y correlación). */
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
  await actAs(db, user, {
    "x-cp-client-ip": "203.0.113.7",
    "user-agent": "Prueba/1.0",
    "x-cp-request-id": randomUUID(),
  });
  const { rows } = await db.query<{ r: { result: string } }>(
    "select public.accept_invitation($1) as r",
    [sha],
  );
  await actAsPostgres(db);
  expect(rows[0].r).toEqual({ result: "wrong_email" });
  return id;
}
type OrgRow = {
  actor_user_id: string | null;
  ip: string | null;
  user_agent: string | null;
  correlation_id: string | null;
};
const orgRows = async (invitationId: string): Promise<OrgRow[]> => {
  await actAsPostgres(db);
  return (
    await db.query<OrgRow>(
      `select actor_user_id, host(origin_ip) as ip, user_agent, correlation_id from public.audit_log
        where action = 'invitation.accept_denied' and tenant_id = $1 and resource_id = $2`,
      [w.tenantA, invitationId],
    )
  ).rows;
};
const platformRows = async (invitationId: string) => {
  await actAsPostgres(db);
  return (
    await db.query<{ actor_user_id: string; ip: string | null; user_agent: string | null }>(
      `select actor_user_id, host(origin_ip) as ip, user_agent from public.audit_log
        where action = 'invitation.accept_denied' and tenant_id = app.platform_tenant_id() and resource_id = $1`,
      [invitationId],
    )
  ).rows;
};
/** Una persona nueva con fila en `members` de A en ese estado (montaje directo). */
async function memberOfA(status: "active" | "removed"): Promise<TestUser> {
  await actAsPostgres(db);
  const user = await createUser(db);
  await db.query(
    `insert into public.members (tenant_id, user_id, role, status, removed_at)
     values ($1, $2, 'sales', $3, case when $3 = 'removed' then now() end)`,
    [w.tenantA, user.id, status],
  );
  return user;
}

describe("la migración invitation_audit_active_only y su deshacer", () => {
  it("AA1 · forma de los archivos: `lock_timeout` y su verificación van primero, solo se redefine la ayuda y no se borra nada", () => {
    for (const [name, sql] of [
      ["migración", up],
      ["deshacer", down],
    ] as const) {
      const body = code(sql).trimStart();
      expect(body.startsWith("set local lock_timeout = '3s';"), name).toBe(true);
      // Justo después, la verificación de que el valor quedó puesto.
      const second = body.slice("set local lock_timeout = '3s';".length).trimStart();
      expect(second.startsWith("do $$"), name).toBe(true);
      expect(second.slice(0, second.indexOf("end $$")), name).toContain(
        "if current_setting('lock_timeout') <> '3s' then",
      );
      expect(
        [...code(sql).matchAll(/create (?:or replace )?function ([a-z_.]+)\(/gi)].map((m) => m[1]),
        name,
      ).toEqual(["app.invitation_audit_wrong_email"]);
      expect(code(sql), name).not.toMatch(
        /\b(drop|truncate|alter\s+table|delete\s+from|update\s+public)\b/i,
      );
      expect(code(sql), name).not.toMatch(/function\s+public\.accept_invitation\b/i);
      expect(code(sql), name).toContain(
        "revoke all on function app.invitation_audit_wrong_email(public.invitations, uuid, text) from public, anon, authenticated;",
      );
    }
  });

  it("AA2 · la función vigente es la de la migración; tras el deshacer, EXACTAMENTE la de 20261109110000; mismos atributos y permisos", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const current = await definition(AUDIT_SIG);
      expect(current.src).toBe(functionBodyIn(up, "app.invitation_audit_wrong_email"));
      expect(current.lang).toBe("plpgsql");

      await db.query(down);

      const restored = await definition(AUDIT_SIG);
      expect(restored.src).toBe(functionBodyIn(previous, "app.invitation_audit_wrong_email"));
      expect(restored.lang).toBe("plpgsql");
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

  it("AA3 · con la migración, quien fue quitado deja su id pero no su IP, navegador ni correlación; sin ella (deshecha) los deja; reaplicada, otra vez no. Miembro activo y de fuera no cambian", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const outsider = await createUser(db);
      const active = await memberOfA("active");
      const former = await memberOfA("removed");
      const person = await createUser(db);

      const check = async (label: string, expectFormerIp: boolean) => {
        const o = await attempt(outsider, `o-${label}-${person.email}`);
        expect(await orgRows(o), `${label}: de fuera`).toEqual([
          { actor_user_id: null, ip: null, user_agent: null, correlation_id: null },
        ]);
        const a = await attempt(active, `a-${label}-${person.email}`);
        const activeRows = await orgRows(a);
        expect(activeRows, `${label}: activo`).toHaveLength(1);
        expect(activeRows[0]).toMatchObject({
          actor_user_id: active.id,
          ip: "203.0.113.7",
          user_agent: "Prueba/1.0",
        });
        expect(activeRows[0].correlation_id, `${label}: activo`).not.toBeNull();
        const f = await attempt(former, `f-${label}-${person.email}`);
        const formerRows = await orgRows(f);
        expect(formerRows, `${label}: quitado`).toHaveLength(1);
        expect(formerRows[0].actor_user_id, `${label}: quitado`).toBe(former.id);
        if (expectFormerIp) {
          expect(formerRows[0]).toMatchObject({ ip: "203.0.113.7", user_agent: "Prueba/1.0" });
          expect(formerRows[0].correlation_id).not.toBeNull();
        } else {
          expect(formerRows[0]).toMatchObject({ ip: null, user_agent: null, correlation_id: null });
        }
        // La copia de la plataforma lleva siempre todo, con cualquier versión.
        for (const [id, user] of [
          [o, outsider],
          [a, active],
          [f, former],
        ] as const) {
          const copies = await platformRows(id);
          expect(copies, `${label}: copia`).toEqual([
            { actor_user_id: user.id, ip: "203.0.113.7", user_agent: "Prueba/1.0" },
          ]);
        }
      };

      await check("con la migración", false);
      await db.query(down);
      await check("deshecha", true);
      await db.query(up);
      await check("reaplicada", false);
    }));

  it("AA4 · `accept_invitation` es la misma con la migración y tras el deshacer", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const before = await definition(ACCEPT_SIG);
      await db.query(down);
      expect(await definition(ACCEPT_SIG)).toEqual(before);
      await db.query(up);
      expect(await definition(ACCEPT_SIG)).toEqual(before);
    }));

  it("AA5 · la verificación detiene el archivo si `lock_timeout` no quedó en 3 s (migración y deshacer), y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const before = await definition(AUDIT_SIG);
      for (const [name, sql] of [
        ["migración", up],
        ["deshacer", down],
      ] as const) {
        const tampered = sql.replace(
          "set local lock_timeout = '3s';",
          "set local lock_timeout = '5s';",
        );
        expect(tampered, name).not.toBe(sql);
        const refused = await expectSqlError(db, tampered);
        expect(refused.message, name).toContain("lock_timeout no quedo en 3s");
      }
      expect(await definition(AUDIT_SIG)).toEqual(before);
    }));
});
