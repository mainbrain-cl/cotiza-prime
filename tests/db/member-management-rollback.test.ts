// H-010 · El «deshacer» de la migración `member_management` hace lo que dice: borra las tres funciones y sus ayudas,
// devuelve `profiles_select` a la regla de antes (solo el nombre de los miembros ACTIVOS) y `members_select` a la de la
// migración 2 (todas las filas de la organización activa), y NO toca a los miembros ya quitados ni a las invitaciones
// ya canceladas. Se ejecuta el archivo real dentro de una transacción que se
// deshace; el deshacer completo y en orden lo prueba `npm run test:db:rollbacks`.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, createUser, withTx } from "./helpers";
import { asUser, buildWorld, type World } from "./send-helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const NAME = "20261105110000_member_management";
const down = readFileSync(path.join(ROOT, "rollbacks", `${NAME}.down.sql`), "utf8");
const up = readFileSync(path.join(ROOT, "migrations", `${NAME}.sql`), "utf8");
const h008 = readFileSync(path.join(ROOT, "migrations", "20261030100000_invitations.sql"), "utf8");

/** El cuerpo (entre los `$$`) de una función tal como la dejó la migración de H-008. */
function originalBody(fn: string): string {
  const start = h008.indexOf(`create function public.${fn}(`);
  const open = h008.indexOf("$$", start) + 2;
  return h008.slice(open, h008.indexOf("$$;", open));
}
const bodyOf = async (fn: string) =>
  (
    await db.query<{ prosrc: string }>(
      "select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1",
      [fn],
    )
  ).rows[0].prosrc;
const readableProfileColumns = async () =>
  (
    await db.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'profiles' and grantee = 'authenticated'
          and privilege_type = 'SELECT' order by 1`,
    )
  ).rows.map((r) => r.column_name);

let db: Client;
let w: World;
beforeAll(async () => {
  db = await connect();
  w = await buildWorld(db);
});
afterAll(async () => {
  await db.end();
});

const exists = async (signature: string): Promise<boolean> =>
  (
    await db.query<{ found: boolean }>("select to_regprocedure($1) is not null as found", [
      signature,
    ])
  ).rows[0].found;

const FUNCTIONS = [
  "public.list_members()",
  "public.change_member_role(uuid, text, text)",
  "public.remove_member(uuid, text)",
  "app.cancel_member_invitations(uuid, uuid, uuid)",
  "app.member_role_change_max_per_hour()",
  "app.current_tenant_people()",
];

/** La definición actual de una política de lectura, para compararla antes y después. */
const policyOf = async (table: "profiles" | "members") =>
  (
    await db.query<{ qual: string }>(
      "select qual from pg_policies where schemaname = 'public' and tablename = $1 and policyname = $2",
      [table, `${table}_select`],
    )
  ).rows[0].qual;
const policy = () => policyOf("profiles");

describe("el deshacer de member_management", () => {
  it("existe el archivo y cada función de la migración aparece en él", () => {
    for (const signature of FUNCTIONS) {
      const name = signature.split("(")[0];
      expect(down, name).toContain(`drop function if exists ${name}(`);
    }
    expect(down).toContain("alter policy profiles_select on public.profiles");
  });

  it("borra las funciones y devuelve la política de perfiles a solo miembros activos; lo ya quitado queda quitado", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      for (const signature of FUNCTIONS) expect(await exists(signature), signature).toBe(true);
      expect(await policy()).not.toContain("'active'");
      expect(await policy()).toContain("current_tenant_people");
      // `members_select`: las filas de quien se fue, solo con `team.manage`.
      expect(await policyOf("members")).toContain("team.manage");
      // Con la migración puesta, las dos funciones bloquean la fila de quien actúa y `profiles` deja solo el nombre.
      for (const fn of ["create_invitation", "resend_invitation"]) {
        expect(await bodyOf(fn), fn).toContain("for share");
        expect(await bodyOf(fn), fn).not.toBe(originalBody(fn));
      }
      expect(await readableProfileColumns()).toEqual(["full_name", "tenant_id", "user_id"]);

      // Un miembro quitado con su nombre visible (política nueva), y su fila de `members` oculta al Observador.
      const person = await createUser(db, { meta: { full_name: "Persona Que Se Fue" } });
      await db.query(
        `insert into public.members (tenant_id, user_id, role, status, removed_at, removed_by)
         values ($1, $2, 'sales', 'removed', now(), $3)`,
        [w.tenantA, person.id, w.owner.id],
      );
      await asUser(db, w.owner, w.tenantA);
      expect(
        (await db.query("select 1 from public.profiles where user_id = $1", [person.id])).rowCount,
      ).toBe(1);
      await asUser(db, w.viewer, w.tenantA);
      expect(
        (await db.query("select 1 from public.members where user_id = $1", [person.id])).rowCount,
      ).toBe(0);
      await actAsPostgres(db);

      await db.query(down);

      for (const signature of FUNCTIONS) expect(await exists(signature), signature).toBe(false);
      expect(await policy()).toContain("'active'");
      expect(await policyOf("members")).not.toContain("team.manage");
      // `create_invitation` y `resend_invitation` vuelven EXACTAMENTE a como las dejó H-008 (sin el bloqueo nuevo).
      for (const fn of ["create_invitation", "resend_invitation"]) {
        expect(await bodyOf(fn), fn).toBe(originalBody(fn));
        expect(await bodyOf(fn), fn).not.toContain("for share");
      }
      // `profiles` vuelve a conceder `created_at` y `updated_at` (migración 12).
      expect(await readableProfileColumns()).toEqual([
        "created_at",
        "full_name",
        "tenant_id",
        "updated_at",
        "user_id",
      ]);
      // Con la política de antes, el nombre de quien se fue ya no se lee; el del equipo activo sí.
      await asUser(db, w.owner, w.tenantA);
      expect(
        (await db.query("select 1 from public.profiles where user_id = $1", [person.id])).rowCount,
      ).toBe(0);
      expect(
        (await db.query("select 1 from public.profiles where user_id = $1", [w.sales.id])).rowCount,
      ).toBe(1);
      // Con la política de antes, el Observador vuelve a ver la fila de quien se fue.
      await asUser(db, w.viewer, w.tenantA);
      expect(
        (await db.query("select 1 from public.members where user_id = $1", [person.id])).rowCount,
      ).toBe(1);
      await actAsPostgres(db);
      // El miembro quitado sigue quitado.
      const row = await db.query(
        "select status from public.members where user_id = $1 and tenant_id = $2",
        [person.id, w.tenantA],
      );
      expect(row.rows).toEqual([{ status: "removed" }]);
    }));

  it("la migración se puede volver a aplicar después de deshacerla", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const before = await policy();
      const membersBefore = await policyOf("members");
      await db.query(down);
      await db.query(up);
      for (const signature of FUNCTIONS) expect(await exists(signature), signature).toBe(true);
      expect(await policy()).toBe(before);
      expect(await policyOf("members")).toBe(membersBefore);
      expect(await readableProfileColumns()).toEqual(["full_name", "tenant_id", "user_id"]);
      expect(await bodyOf("create_invitation")).toContain("for share");
    }));
});
