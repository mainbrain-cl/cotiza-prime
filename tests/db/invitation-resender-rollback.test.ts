// H-010 · corrección de la revisión del 2026-11-06 · El «deshacer» de `invitation_resender` borra la columna
// `resent_by`, el índice, las dos ayudas y la limpieza, y devuelve `app.invitation_state`, `public.resend_invitation` y
// `app.cancel_member_invitations` EXACTAMENTE a como las dejaron las migraciones anteriores (mismo texto, mismos
// permisos). No revive las invitaciones que la migración canceló al aplicarse. La migración se puede volver a aplicar,
// y al aplicarla sobre datos de antes rellena `resent_by` y cancela lo que corresponde, una sola vez. Se ejecutan los
// archivos reales dentro de una transacción que se deshace; el deshacer completo y en orden lo prueba
// `npm run test:db:rollbacks`.
// Desde la corrección D3 (20261109100000_invitation_accept_sender) hay una migración POSTERIOR que lee `resent_by`
// (`accept_invitation`), y desde el menor 1 del PR #35 (20261109120000_member_invitation_creator) otra más que vuelve a
// redefinirla: para deshacer esta, primero se deshacen aquellas, de la más nueva a la más antigua (`applyDowns`), como en
// el orden real. El deshacer de esta migración se niega a correr si no se hizo así (RB6 a RB8).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationEmailBinding } from "../../src/lib/team/invitation-code";
import {
  actAsPostgres,
  connect,
  createUser,
  expectSqlError,
  withTx,
  type TestUser,
} from "./helpers";
import { asUser, buildWorld, newToken, sha256Hex, type World } from "./send-helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const NAME = "20261106100000_invitation_resender";
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
/** Los deshacer de las migraciones posteriores, que se aplican ANTES que el de esta (el más nuevo primero). */
const downNewer = read("rollbacks", "20261109100000_invitation_accept_sender.down.sql");
const downNewest = read("rollbacks", "20261109120000_member_invitation_creator.down.sql");
const previewMigration = read("migrations", "20261105100000_invitation_preview_read_only.sql");
const managementMigration = read("migrations", "20261105110000_member_management.sql");

/** Lo que hay entre los `$$` de una función en una migración (tal como lo guarda `pg_proc.prosrc`). */
function bodyIn(sql: string, signature: string): string {
  const start = sql.indexOf(`function ${signature}(`);
  expect(start, `no encontré ${signature}`).toBeGreaterThan(-1);
  const open = sql.indexOf("$$", start) + 2;
  return sql.slice(open, sql.indexOf("$$", open));
}

let db: Client;
let w: World;
/** Deshace en el orden real: primero lo más nuevo (menor 1 del #35), después D3, después esta migración. */
const applyDowns = async () => {
  await db.query(downNewest);
  await db.query(downNewer);
  await db.query(down);
};
beforeAll(async () => {
  db = await connect();
  w = await buildWorld(db);
});
afterAll(async () => {
  await db.end();
});

type Definition = {
  src: string;
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
      `select p.prosrc as src, p.prosecdef as secdef, p.proconfig as cfg,
              pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as returns,
              p.provolatile as volatility,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('public', p.oid, 'execute') as pub,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p where p.oid = $1::regprocedure`,
      [signature],
    )
  ).rows[0];

const STATE = "app.invitation_state(public.invitations, uuid, text)";
const RESEND_SIG = "public.resend_invitation(uuid, text, text, uuid, text)";
const CANCEL = "app.cancel_member_invitations(uuid, uuid, uuid)";
const NEW_OBJECTS = [
  "app.invitation_sender_ok(uuid, text, uuid)",
  "app.invitation_senders_ok(uuid, text, uuid, uuid)",
  "app.reconcile_invitation_senders()",
];

const exists = async (signature: string): Promise<boolean> =>
  (await db.query<{ f: boolean }>("select to_regprocedure($1) is not null as f", [signature]))
    .rows[0].f;
const hasColumn = async (): Promise<boolean> =>
  (
    await db.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'invitations' and column_name = 'resent_by'`,
    )
  ).rowCount === 1;
const hasIndex = async (): Promise<boolean> =>
  (
    await db.query(
      "select 1 from pg_indexes where schemaname = 'public' and indexname = 'invitations_tenant_resender'",
    )
  ).rowCount === 1;

describe("el deshacer de invitation_resender", () => {
  it("RB1 · el archivo menciona cada objeto que la migración crea", () => {
    for (const signature of NEW_OBJECTS) {
      const name = signature.split("(")[0];
      expect(down, name).toContain(`drop function if exists ${name}(`);
    }
    expect(down).toContain("drop index if exists public.invitations_tenant_resender");
    expect(down).toContain("drop column if exists resent_by");
    for (const fn of [
      "app.invitation_state",
      "public.resend_invitation",
      "app.cancel_member_invitations",
    ]) {
      expect(down, fn).toContain(`create or replace function ${fn}(`);
    }
  });

  it("RB2 · devuelve las tres funciones a su texto anterior, con los mismos permisos, y borra columna, índice y ayudas", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      // Con la migración puesta: la columna, el índice y las ayudas existen y las funciones son las nuevas.
      expect(await hasColumn()).toBe(true);
      expect(await hasIndex()).toBe(true);
      for (const signature of NEW_OBJECTS) expect(await exists(signature), signature).toBe(true);
      const current = {
        state: await definition(STATE),
        resend: await definition(RESEND_SIG),
        cancel: await definition(CANCEL),
      };
      expect(current.state.src.trim()).toBe(bodyIn(up, "app.invitation_state").trim());
      expect(current.state.src).toContain("invitation_senders_ok");
      expect(current.resend.src).toContain("resent_by = v_uid");
      expect(current.cancel.src).toContain("resent_by = p_user");

      await applyDowns();

      expect(await hasColumn()).toBe(false);
      expect(await hasIndex()).toBe(false);
      for (const signature of NEW_OBJECTS) expect(await exists(signature), signature).toBe(false);
      const restored = {
        state: await definition(STATE),
        resend: await definition(RESEND_SIG),
        cancel: await definition(CANCEL),
      };
      // Texto idéntico al de las migraciones anteriores.
      expect(restored.state.src).toBe(bodyIn(previewMigration, "app.invitation_state"));
      expect(restored.resend.src).toBe(bodyIn(managementMigration, "public.resend_invitation"));
      expect(restored.cancel.src).toBe(
        bodyIn(managementMigration, "app.cancel_member_invitations"),
      );
      expect(restored.state.src).not.toContain("resent_by");
      expect(restored.resend.src).not.toContain("resent_by");
      expect(restored.cancel.src).not.toContain("resent_by");
      // Mismos permisos y misma forma que con la migración puesta.
      for (const key of ["state", "resend", "cancel"] as const) {
        const { src: restoredSrc, ...restoredRest } = restored[key];
        const { src: currentSrc, ...currentRest } = current[key];
        expect(restoredSrc).not.toBe(currentSrc);
        expect(restoredRest, key).toEqual(currentRest);
      }
      expect(restored.state).toMatchObject({ anon: false, pub: false, auth: false });
      expect(restored.cancel).toMatchObject({ anon: false, pub: false, auth: false });
      expect(restored.resend).toMatchObject({ anon: false, pub: false, auth: true });
    }));

  it("RB3 · aplicada sobre datos de antes: rellena `resent_by` y cancela solo lo que corresponde; repetir la limpieza no cambia nada y el deshacer no revive nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await applyDowns();

      const removed = await createUser(db, { meta: { full_name: "Admin Que Ya Se Fue" } });
      await db.query(
        `insert into public.members (tenant_id, user_id, role, status, removed_at, removed_by)
         values ($1, $2, 'admin', 'removed', now(), $3)`,
        [w.tenantA, removed.id, w.owner.id],
      );

      /** Una invitación pendiente de antes, con sus correos (el último, de quien se indique), montada a mano. */
      async function legacy(opts: {
        tenant: string;
        role: string;
        invitedBy: TestUser;
        mailBy: TestUser[];
        sendCount?: number;
      }): Promise<string> {
        const id = randomUUID();
        const { sha } = newToken();
        const hash = sha256Hex(`huella|${id}`);
        await db.query(
          `insert into public.invitations
             (id, tenant_id, email_enc, email_hash, email_binding, role, token_sha256, status, expires_at,
              invited_by, send_count, owner_notice_state)
           values ($1, $2, $3, $4, $5, $6, $7, 'pending', now() + interval '3 days', $8, $9, 'pending')`,
          [
            id,
            opts.tenant,
            `v1.cifrado.${id}`,
            hash,
            sha256Hex(`vinculo|${id}`),
            opts.role,
            sha,
            opts.invitedBy.id,
            opts.sendCount ?? opts.mailBy.length,
          ],
        );
        for (const [index, author] of opts.mailBy.entries()) {
          const mailId = randomUUID();
          await db.query(
            `insert into public.email_messages
               (id, tenant_id, invitation_id, kind, to_email_enc, to_email_hash, provider, status, created_by,
                created_at)
             values ($1, $2, $3, 'invitation', $4, $5, 'pending', 'pending', $6,
                     now() - ($7::int * interval '1 hour'))`,
            [mailId, opts.tenant, id, `v1.cifrado.correo.${mailId}`, hash, author.id, 10 - index],
          );
        }
        return id;
      }

      // Se quedan: la reenvió un Administrador que sigue en el equipo; la reenvió el Dueño (aun siendo a Administrador);
      // un solo envío (no se rellena nada); y la de otra organización reenviada por su propio Dueño.
      const resentByActiveAdmin = await legacy({
        tenant: w.tenantA,
        role: "sales",
        invitedBy: w.owner,
        mailBy: [w.owner, w.admin],
      });
      const adminInviteResentByOwner = await legacy({
        tenant: w.tenantA,
        role: "admin",
        invitedBy: w.owner,
        mailBy: [w.owner, w.owner],
      });
      const singleSend = await legacy({
        tenant: w.tenantA,
        role: "sales",
        invitedBy: w.owner,
        mailBy: [w.admin],
      });
      const otherOrgOwn = await legacy({
        tenant: w.tenantB,
        role: "sales",
        invitedBy: w.ownerB,
        mailBy: [w.ownerB, w.ownerB],
      });
      // Se cancelan: la reenvió alguien que ya se fue; una invitación a Administrador del Dueño que desvió un
      // Administrador; y, en otra organización, la reenvió alguien que no es de ella.
      const resentByRemoved = await legacy({
        tenant: w.tenantA,
        role: "sales",
        invitedBy: w.owner,
        mailBy: [w.owner, removed],
      });
      const adminInviteDiverted = await legacy({
        tenant: w.tenantA,
        role: "admin",
        invitedBy: w.owner,
        mailBy: [w.owner, w.admin],
      });
      const otherOrgForeign = await legacy({
        tenant: w.tenantB,
        role: "sales",
        invitedBy: w.ownerB,
        mailBy: [w.ownerB, w.admin],
      });
      // Una aceptada nunca se toca, aunque quien la reenvió ya no esté.
      const acceptedId = randomUUID();
      await db.query(
        `insert into public.invitations
           (id, tenant_id, role, token_sha256, status, expires_at, invited_by, send_count, accepted_at, accepted_by)
         values ($1, $2, 'sales', $3, 'accepted', now() + interval '3 days', $4, 2, now(), $5)`,
        [acceptedId, w.tenantA, newToken().sha, w.owner.id, w.sales.id],
      );
      await db.query(
        `insert into public.email_messages
           (id, tenant_id, invitation_id, kind, to_email_enc, to_email_hash, provider, status, created_by)
         values ($1, $2, $3, 'invitation', 'v1.x.y', $4, 'pending', 'pending', $5)`,
        [randomUUID(), w.tenantA, acceptedId, sha256Hex("x"), removed.id],
      );

      await db.query(up);

      const state = async (id: string) =>
        (
          await db.query(
            `select status, revoke_reason, revoked_by, resent_by, owner_notice_state
               from public.invitations where id = $1`,
            [id],
          )
        ).rows[0];
      expect(await state(resentByActiveAdmin)).toMatchObject({
        status: "pending",
        resent_by: w.admin.id,
      });
      expect(await state(adminInviteResentByOwner)).toMatchObject({
        status: "pending",
        resent_by: w.owner.id,
      });
      expect(await state(singleSend)).toMatchObject({ status: "pending", resent_by: null });
      expect(await state(otherOrgOwn)).toMatchObject({ status: "pending", resent_by: w.ownerB.id });
      for (const id of [resentByRemoved, adminInviteDiverted, otherOrgForeign]) {
        expect(await state(id), id).toMatchObject({
          status: "revoked",
          revoke_reason: "inviter_removed",
          revoked_by: null,
          owner_notice_state: "none",
        });
      }
      expect(await state(acceptedId)).toMatchObject({ status: "accepted", resent_by: null });
      // La limpieza deja constancia: una fila de auditoría `invitation.updated` del sistema por cada cancelada.
      for (const id of [resentByRemoved, adminInviteDiverted, otherOrgForeign]) {
        const audit = await db.query(
          `select actor_type, details from public.audit_log where resource_id = $1 and action = 'invitation.updated'
            order by occurred_at, id`,
          [id],
        );
        expect(audit.rows.length, id).toBeGreaterThan(0);
        expect(
          audit.rows.every((r) => r.actor_type === "system"),
          id,
        ).toBe(true);
        expect(
          audit.rows.flatMap((r) => r.details.changed as string[]),
          id,
        ).toContain("status");
      }

      // Repetir la limpieza no toca nada más.
      const again = await db.query<{ r: { backfilled: number; cancelled: number } }>(
        "select app.reconcile_invitation_senders() as r",
      );
      expect(again.rows[0].r).toEqual({ backfilled: 0, cancelled: 0 });

      // El deshacer no revive nada. Las migraciones posteriores ya se deshicieron al empezar (y no se reaplicaron: solo se
      // volvió a aplicar esta), así que basta con el deshacer de esta.
      await db.query(down);
      for (const id of [resentByRemoved, adminInviteDiverted, otherOrgForeign]) {
        const row = (
          await db.query("select status, revoke_reason from public.invitations where id = $1", [id])
        ).rows[0];
        expect(row, id).toEqual({ status: "revoked", revoke_reason: "inviter_removed" });
      }
      expect(
        (
          await db.query("select status from public.invitations where id = $1", [
            resentByActiveAdmin,
          ])
        ).rows[0].status,
      ).toBe("pending");
    }));

  it("RB4 · la migración se puede volver a aplicar después de deshacerla y deja las funciones del texto de la migración", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const before = {
        state: await definition(STATE),
        resend: await definition(RESEND_SIG),
        cancel: await definition(CANCEL),
      };
      await applyDowns();
      await db.query(up);
      expect(await hasColumn()).toBe(true);
      expect(await hasIndex()).toBe(true);
      for (const signature of NEW_OBJECTS) expect(await exists(signature), signature).toBe(true);
      expect({
        state: await definition(STATE),
        resend: await definition(RESEND_SIG),
        cancel: await definition(CANCEL),
      }).toEqual(before);
      // Las tres ayudas nuevas no las ejecuta nadie con un pase.
      for (const signature of NEW_OBJECTS) {
        expect(await definition(signature), signature).toMatchObject({
          anon: false,
          pub: false,
          auth: false,
        });
      }
    }));

  it("RB6 · la guarda de orden es la primera sentencia del deshacer y solo deja de lado las seis funciones que ese archivo redefine o borra", () => {
    const code = down
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trimStart();
    expect(code.startsWith("do $$"), "la guarda va antes del primer `create or replace`").toBe(
      true,
    );
    expect(code.indexOf("do $$")).toBeLessThan(code.indexOf("create or replace function"));
    // Busca la columna como palabra entera (`p_resent_by` de una ayuda no cuenta) en `public` y `app`, sin distinguir
    // mayúsculas (`~*`).
    expect(code).toContain("p.prosrc ~* '\\mresent_by\\M'");
    expect(code).not.toMatch(/prosrc ~ '/);
    // Las excepciones van por FIRMA completa (`to_regprocedure`), no por nombre: leídas del propio archivo.
    expect(code).toContain("to_regprocedure(t.sig)::oid = p.oid");
    const excluded = [
      ...code.slice(0, code.indexOf("end $$")).matchAll(/'((?:app|public)\.[a-z_]+\([^']*\))'/g),
    ]
      .map((m) => m[1])
      .sort();
    // Exactamente las funciones que ese archivo redefine (`create or replace`) o borra (`drop function`): ni una más ni una
    // menos (seis). Los nombres se leen del propio archivo y las firmas deben ser las de las constantes de esta prueba.
    const touched = [
      ...code.matchAll(
        /(?:create or replace function|drop function if exists) ((?:app|public)\.[a-z_]+)\(/g,
      ),
    ]
      .map((m) => m[1])
      .sort();
    expect(touched).toHaveLength(6);
    expect(excluded.map((signature) => signature.split("(")[0])).toEqual(touched);
    expect(excluded).toEqual([STATE, RESEND_SIG, CANCEL, ...NEW_OBJECTS].sort());
  });
  it("RB7 · fuera de orden se niega: con la migración posterior (D3) puesta, el deshacer falla, nombra `accept_invitation` y no cambia nada", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      // (a) Con todo puesto, `accept_invitation` es la del menor 1 del #35 y también lee `resent_by`.
      const all = await expectSqlError(db, down);
      expect(all.message).toContain("public.accept_invitation(");
      // El mensaje dice el orden completo: primero el más nuevo.
      expect(all.message).toContain("20261109120000_member_invitation_creator.down.sql");
      // (b) Solo con D3 puesta (se deshace lo más nuevo): lo mismo, y el mensaje señala el deshacer que falta.
      await db.query(downNewest);
      const onlyD3 = await expectSqlError(db, down);
      expect(onlyD3.message).toContain("public.accept_invitation(");
      expect(onlyD3.message).toContain("20261109100000_invitation_accept_sender.down.sql");
      // No cambió nada: la columna, el índice y las ayudas siguen ahí.
      expect(await hasColumn()).toBe(true);
      expect(await hasIndex()).toBe(true);
      for (const signature of NEW_OBJECTS) expect(await exists(signature), signature).toBe(true);
      // (c) En el orden correcto, pasa.
      await db.query(downNewer);
      await db.query(down);
      expect(await hasColumn()).toBe(false);
    }));

  it("RB8 · la guarda es general: una función cualquiera que lea `resent_by` hace que se niegue y la nombra; sin ella (o si solo tiene `p_resent_by`) pasa", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(downNewest);
      await db.query(downNewer);
      // Un parámetro llamado `p_resent_by` NO cuenta (como el de `app.invitation_senders_ok`).
      await db.query(
        `create function app.rb8_harmless(p_resent_by uuid) returns uuid language sql immutable
           set search_path = '' as $$ select p_resent_by $$`,
      );
      await db.query(
        `create function app.rb8_reader() returns uuid language sql stable
           set search_path = '' as $$ select i.resent_by from public.invitations i limit 1 $$`,
      );
      const refused = await expectSqlError(db, down);
      expect(refused.message).toContain("app.rb8_reader(");
      expect(refused.message).not.toContain("rb8_harmless");
      expect(await hasColumn()).toBe(true);
      await db.query("drop function app.rb8_reader()");
      await db.query(down);
      expect(await hasColumn()).toBe(false);
    }));

  it("RB5 · sin la migración, el ataque exacto vuelve a funcionar (por eso esta prueba demuestra lo que corrige)", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await applyDowns();
      const accomplice = await createUser(db);
      // El Dueño invita a un Comercial; el Administrador la reenvía atada al correo del cómplice y lo quitan.
      const id = randomUUID();
      const { sha } = newToken();
      const mailId = randomUUID();
      const target = `objetivo-${id.slice(0, 8)}@ejemplo.test`;
      await asUser(db, w.owner, w.tenantA);
      await db.query("select public.create_invitation($1, $2, $3, $4, $5, $6, $7, $8)", [
        id,
        `v1.cifrado.${id}`,
        sha256Hex(`huella|${target}`),
        invitationEmailBinding(sha, target),
        sha,
        "sales",
        mailId,
        `v1.cifrado.correo.${mailId}`,
      ]);
      await actAsPostgres(db);
      await db.query(
        "update public.invitations set last_sent_at = now() - interval '1 hour' where id = $1",
        [id],
      );
      const stolen = newToken().sha;
      const resendMail = randomUUID();
      await asUser(db, w.admin, w.tenantA);
      await db.query("select public.resend_invitation($1, $2, $3, $4, $5)", [
        id,
        invitationEmailBinding(stolen, accomplice.email),
        stolen,
        resendMail,
        `v1.cifrado.correo.${resendMail}`,
      ]);
      await asUser(db, w.owner, w.tenantA);
      const memberId = (
        await db.query<{ id: string }>(
          "select id from public.members where tenant_id = $1 and user_id = $2",
          [w.tenantA, w.admin.id],
        )
      ).rows[0].id;
      const removedResult = (
        await db.query<{ r: { cancelled_invitations: number } }>(
          "select public.remove_member($1, 'admin') as r",
          [memberId],
        )
      ).rows[0].r;
      // Antes de la corrección: no se cancela nada y el cómplice entra.
      expect(removedResult.cancelled_invitations).toBe(0);
      await asUser(db, accomplice, w.tenantA);
      const accepted = (
        await db.query<{ r: { result: string; role: string } }>(
          "select public.accept_invitation($1) as r",
          [stolen],
        )
      ).rows[0].r;
      expect(accepted).toMatchObject({ result: "accepted", role: "sales" });
    }));
});
