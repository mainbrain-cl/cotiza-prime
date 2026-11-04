// H-009 · El «deshacer» de la migración `invitation_accept` hace lo que dice: borra las dos funciones y sus
// ayudas, devuelve la lista de alcances del límite de intentos a la de antes y NO toca lo ya aceptado. Se ejecuta
// el archivo real dentro de una transacción que se deshace; el deshacer completo y en orden lo prueba
// `npm run test:db:rollbacks`.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, createUser, expectSqlError, withTx } from "./helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const NAME = "20261103100000_invitation_accept";
const down = readFileSync(path.join(ROOT, "rollbacks", `${NAME}.down.sql`), "utf8");

let db: Client;
beforeAll(async () => {
  db = await connect();
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
  "public.accept_invitation(text)",
  "public.invitation_preview(text)",
  "app.invitation_state(public.invitations, uuid, text)",
  "app.invitation_audit_wrong_email(public.invitations, uuid, text)",
  "app.invitation_accept_fail(uuid)",
  "app.invitation_accept_locked(uuid)",
  "app.invitation_accept_key(uuid)",
  "app.invitation_accept_max_failures()",
  "app.invitation_accept_window_seconds()",
  "app.invitation_accept_lock_seconds()",
];

describe("el deshacer de invitation_accept", () => {
  it("existe el archivo y cada función de la migración aparece en él", () => {
    for (const signature of FUNCTIONS) {
      const name = signature.split("(")[0];
      expect(down, name).toContain(`drop function if exists ${name}(`);
    }
  });

  it("borra las funciones, quita los dos alcances y borra sus contadores; lo ya aceptado queda", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      for (const signature of FUNCTIONS) expect(await exists(signature), signature).toBe(true);

      // Un contador de cada alcance nuevo y uno de un alcance de antes.
      const stub = "a".repeat(64);
      for (const scope of ["invite_accept_user", "invite_link_ip", "login_ip"]) {
        await db.query(
          "insert into public.auth_rate_limits (scope, key_hash, failures) values ($1, $2, 1)",
          [scope, stub],
        );
      }
      // Una invitación aceptada (historia que debe sobrevivir).
      const person = await createUser(db);
      const tenant = (
        await db.query<{ tenant_id: string }>(
          "select tenant_id from public.tenants where kind = 'organization' limit 1",
        )
      ).rows[0]?.tenant_id;
      expect(tenant).toBeTruthy();
      const inviteId = "9d2b6f0e-1111-4b7c-9c1d-000000000009";
      await db.query("set local session_replication_role = replica");
      await db.query(
        `insert into public.members (id, tenant_id, user_id, role) values ($1, $2, $3, 'viewer')`,
        ["9d2b6f0e-1111-4b7c-9c1d-00000000000a", tenant, person.id],
      );
      await db.query(
        `insert into public.invitations
           (id, tenant_id, role, token_sha256, status, expires_at, invited_by, accepted_at, accepted_by, member_id)
         values ($1, $2, 'viewer', $3, 'accepted', now() + interval '1 day', $4, now(), $4, $5)`,
        [inviteId, tenant, "b".repeat(64), person.id, "9d2b6f0e-1111-4b7c-9c1d-00000000000a"],
      );
      await db.query("set local session_replication_role = origin");

      await db.query(down);

      for (const signature of FUNCTIONS) expect(await exists(signature), signature).toBe(false);
      const scopes = (
        await db.query<{ scope: string }>("select scope from public.auth_rate_limits")
      ).rows.map((r) => r.scope);
      expect(scopes).toContain("login_ip");
      expect(scopes).not.toContain("invite_accept_user");
      expect(scopes).not.toContain("invite_link_ip");
      // Los alcances nuevos ya no se aceptan; los de antes siguen.
      for (const scope of ["invite_accept_user", "invite_link_ip"]) {
        const error = await expectSqlError(
          db,
          "insert into public.auth_rate_limits (scope, key_hash) values ($1, $2)",
          [scope, "c".repeat(64)],
        );
        expect(error.code, scope).toBe("23514");
      }
      await db.query(
        "insert into public.auth_rate_limits (scope, key_hash) values ('intake_submit_form', $1)",
        ["d".repeat(64)],
      );
      // La invitación aceptada sigue donde estaba.
      expect(
        (await db.query("select status from public.invitations where id = $1", [inviteId])).rows,
      ).toEqual([{ status: "accepted" }]);
    }));

  it("la migración se puede volver a aplicar después de deshacerla", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const up = readFileSync(path.join(ROOT, "migrations", `${NAME}.sql`), "utf8");
      await db.query(down);
      await db.query(up);
      for (const signature of FUNCTIONS) expect(await exists(signature), signature).toBe(true);
    }));
});
