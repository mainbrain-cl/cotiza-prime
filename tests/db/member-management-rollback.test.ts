// H-010 · El «deshacer» de la migración `member_management` hace lo que dice: borra las tres funciones y sus ayudas,
// devuelve `profiles_select` a la regla de antes (solo el nombre de los miembros ACTIVOS) y `members_select` a la de la
// migración 2 (todas las filas de la organización activa), y NO toca a los miembros ya quitados ni a las invitaciones
// ya canceladas. También, que al aplicarse la migración cancela las invitaciones pendientes a un rol que maneja el
// equipo hechas por quien no es el Dueño, que repetirlo no cambia nada y que el deshacer no las devuelve. Se ejecuta el
// archivo real dentro de una transacción que se deshace; el deshacer completo y en orden lo prueba
// `npm run test:db:rollbacks`.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTxBeforeMfaGate as withTx } from "./before-mfa-gate";
import { actAsPostgres, connect, createUser } from "./helpers";
import { asUser, buildWorld, newToken, sha256Hex, type World } from "./send-helpers";

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
  "app.member_change_max_per_hour()",
  "app.member_changes_exhausted(uuid, uuid)",
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

/** Una invitación pendiente insertada a mano (montaje directo, como postgres). Devuelve su id. */
async function insertPending(
  tenant: string,
  invitedBy: string,
  role: string,
  ownerNotice: "none" | "pending",
): Promise<string> {
  const id = randomUUID();
  const { sha } = newToken();
  await db.query(
    `insert into public.invitations
       (id, tenant_id, email_enc, email_hash, email_binding, role, token_sha256, status, expires_at, invited_by,
        owner_notice_state)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending', now() + interval '7 days', $8, $9)`,
    [
      id,
      tenant,
      `v1.cifrado.${id}`,
      sha256Hex(`huella|${id}`),
      sha256Hex(`vinculo|${id}`),
      role,
      sha,
      invitedBy,
      ownerNotice,
    ],
  );
  return id;
}

const invitation = async (id: string) =>
  (
    await db.query(
      `select status, revoke_reason, revoked_by, owner_notice_state, revoked_at is not null as revoked
         from public.invitations where id = $1`,
      [id],
    )
  ).rows[0];

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
      // Con la migración puesta, las dos funciones bloquean la fila de quien actúa y exigen al Dueño para un rol que
      // maneja el equipo (`owner_only`), y `profiles` deja solo el nombre.
      for (const fn of ["create_invitation", "resend_invitation"]) {
        expect(await bodyOf(fn), fn).toContain("for share");
        expect(await bodyOf(fn), fn).toContain("owner_only");
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
        expect(await bodyOf(fn), fn).not.toContain("owner_only");
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

  it("al aplicarse cancela las invitaciones pendientes a un rol que maneja el equipo hechas por quien no es el Dueño; repetirlo no cambia nada y el deshacer no las devuelve", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(down);
      // Montaje: invitaciones como las que H-008 dejaba crear antes de esta migración.
      const legacy = await insertPending(w.tenantA, w.admin.id, "admin", "pending");
      const bySales = await insertPending(w.tenantA, w.sales.id, "admin", "none");
      const byOwner = await insertPending(w.tenantA, w.owner.id, "admin", "none");
      const adminSales = await insertPending(w.tenantA, w.admin.id, "sales", "none");
      const ownerInB = await insertPending(w.tenantB, w.ownerB.id, "admin", "none");
      // Quien es Dueño en A no lo es en B: su invitación a Administrador en B también se cancela.
      const ownerAInB = await insertPending(w.tenantB, w.owner.id, "admin", "none");

      await db.query(up);

      for (const id of [legacy, bySales, ownerAInB]) {
        expect(await invitation(id), id).toMatchObject({
          status: "revoked",
          revoke_reason: "inviter_removed",
          revoked_by: null,
          owner_notice_state: "none",
          revoked: true,
        });
      }
      for (const id of [byOwner, adminSales, ownerInB]) {
        expect(await invitation(id), id).toMatchObject({ status: "pending", revoke_reason: null });
      }
      // La misma auditoría que deja `app.cancel_member_invitations`: el disparador anota el cambio (aquí, de `system`).
      const audit = await db.query(
        `select actor_type, details from public.audit_log
          where tenant_id = $1 and resource_id = $2 and action = 'invitation.updated'`,
        [w.tenantA, legacy],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_type).toBe("system");
      expect(audit.rows[0].details.changed).toEqual(
        expect.arrayContaining(["status", "revoke_reason", "revoked_at"]),
      );

      // Repetir la cancelación no toca nada más: solo mira las que siguen pendientes.
      const cancel = up.slice(up.lastIndexOf("update public.invitations i"));
      expect(cancel).toContain("i.status = 'pending'");
      expect((await db.query(cancel)).rowCount).toBe(0);
      for (const id of [byOwner, adminSales, ownerInB]) {
        expect((await invitation(id)).status, id).toBe("pending");
      }

      // El deshacer no las devuelve.
      await db.query(down);
      for (const id of [legacy, bySales, ownerAInB]) {
        expect((await invitation(id)).status, id).toBe("revoked");
      }
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
      for (const fn of ["create_invitation", "resend_invitation"]) {
        expect(await bodyOf(fn), fn).toContain("for share");
        expect(await bodyOf(fn), fn).toContain("owner_only");
      }
    }));
});
