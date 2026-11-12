// H-010 · corrección D3 y menores 1 y 2 de la revisión de Aarón al PR #33 (2026-11-09) · migración
// 20261109100000_invitation_accept_sender. Dos funciones cambian y nada más:
//   · `accept_invitation` guarda en `members.invited_by` a quien envió el enlace por última vez (D3);
//   · `app.reconcile_invitation_senders` rellena solo donde `resent_by` es nulo (menor 1) y con el mismo desempate que
//     `resend_invitation` (menor 2).
// Aquí se prueba que el «deshacer» devuelve cada función EXACTAMENTE a su texto anterior (con los mismos permisos), que se
// puede volver a aplicar, y que SIN la migración los dos problemas siguen ahí (por eso las pruebas lo demuestran). Se
// ejecutan los archivos reales dentro de una transacción que se deshace; el deshacer completo y en orden lo prueba
// `npm run test:db:rollbacks`. Desde el menor 1 del PR #35 (20261109120000) `accept_invitation` la redefine otra migración:
// las pruebas que comparan la función vigente con la de esta migración deshacen primero esa (`downNewer`). Todo es ficticio.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationEmailBinding } from "../../src/lib/team/invitation-code";
import { actAsPostgres, connect, createUser, expectSqlError, type TestUser } from "./helpers";
import { withTxBeforeMfaGate as withTx } from "./before-mfa-gate";
import { asUser, buildWorld, newToken, sha256Hex, type World } from "./send-helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const NAME = "20261109100000_invitation_accept_sender";
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
/**
 * El deshacer de la migración POSTERIOR que vuelve a redefinir `accept_invitation` (20261109120000_member_invitation_creator,
 * menor 1 del PR #35). Para probar ESTA migración, la función vigente tiene que ser la suya: se deshace primero lo más nuevo,
 * como en el orden real.
 */
const downNewer = read("rollbacks", "20261109120000_member_invitation_creator.down.sql");
const acceptMigration = read("migrations", "20261103100000_invitation_accept.sql");
const resenderMigration = read("migrations", "20261106100000_invitation_resender.sql");

const ACCEPT_SIG = "public.accept_invitation(text)";
const RECONCILE_SIG = "app.reconcile_invitation_senders()";
const RESEND_SIG = "public.resend_invitation(uuid, text, text, uuid, text)";

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

const withoutSrc = (definition: Definition): Omit<Definition, "src"> => {
  const copy: Partial<Definition> = { ...definition };
  delete copy.src;
  return copy as Omit<Definition, "src">;
};

describe("el deshacer de invitation_accept_sender", () => {
  it("NR1 · el deshacer solo redefine las dos funciones (sin ningún drop) y la migración no toca resend_invitation, invitation_state ni invitation_preview", () => {
    for (const fn of [ACCEPT_SIG, RECONCILE_SIG]) {
      const name = fn.split("(")[0];
      expect(down, name).toContain(`create or replace function ${name}(`);
      expect(up, name).toContain(`create or replace function ${name}(`);
    }
    const code = (sql: string) =>
      sql
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");
    expect(code(down)).not.toMatch(/\bdrop\b/i);
    expect(code(down)).not.toMatch(/\b(truncate|alter\s+table|delete\s+from)\b/i);
    for (const untouched of [
      "public.resend_invitation",
      "app.invitation_state",
      "public.invitation_preview",
    ]) {
      expect(code(up), untouched).not.toMatch(new RegExp(`function\\s+${untouched}\\b`));
      expect(code(down), untouched).not.toMatch(new RegExp(`function\\s+${untouched}\\b`));
    }
    // La migración no llama a la limpieza (repetirla es decisión de quien despliega).
    expect(code(up)).not.toMatch(/select\s+app\.reconcile_invitation_senders/i);
  });

  it("NR2 · las definiciones vigentes son el texto de esta migración; tras el deshacer, el de las anteriores; mismos atributos y permisos", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      // Primero lo más nuevo: así `accept_invitation` vigente es la de ESTA migración.
      await db.query(downNewer);
      const current = {
        accept: await definition(ACCEPT_SIG),
        reconcile: await definition(RECONCILE_SIG),
      };
      expect(current.accept.src.trim()).toBe(bodyIn(up, ACCEPT_SIG).trim());
      expect(current.reconcile.src.trim()).toBe(bodyIn(up, RECONCILE_SIG).trim());
      expect(current.accept.src).toContain("coalesce(v_inv.resent_by, v_inv.invited_by)");
      expect(current.reconcile.src).toContain("i.resent_by is null");

      await db.query(down);

      const restored = {
        accept: await definition(ACCEPT_SIG),
        reconcile: await definition(RECONCILE_SIG),
      };
      expect(restored.accept.src).toBe(bodyIn(acceptMigration, ACCEPT_SIG));
      expect(restored.reconcile.src).toBe(bodyIn(resenderMigration, RECONCILE_SIG));
      expect(restored.accept.src).not.toContain("v_sender");
      expect(restored.reconcile.src).not.toContain("i.resent_by is null");
      // Mismos atributos y permisos que con la migración puesta.
      expect(withoutSrc(restored.accept)).toEqual(withoutSrc(current.accept));
      expect(withoutSrc(restored.reconcile)).toEqual(withoutSrc(current.reconcile));
      expect(restored.accept).toMatchObject({ secdef: true, anon: false, pub: false, auth: true });
      expect(restored.reconcile).toMatchObject({
        secdef: false,
        anon: false,
        pub: false,
        auth: false,
      });
    }));

  it("NR2b · lo que cambia en `accept_invitation` son solo las líneas anunciadas (v_sender, created_by, sent_by) y tres líneas que ahora usan v_sender", () => {
    const oldLines = new Set(
      bodyIn(acceptMigration, ACCEPT_SIG)
        .split("\n")
        .map((line) => line.trim()),
    );
    const newLines = new Set(
      bodyIn(up, ACCEPT_SIG)
        .split("\n")
        .map((line) => line.trim()),
    );
    const added = [...newLines].filter((line) => !oldLines.has(line));
    const removed = [...oldLines].filter((line) => !newLines.has(line));
    for (const line of added) {
      expect(line, "línea nueva fuera de lo anunciado").toMatch(
        /v_sender|sent_by|created_by|^--|^`resent_by`|^jsonb_build_object\('role'/,
      );
    }
    // Las que desaparecen son exactamente las tres que escribían `v_inv.invited_by` / el resultado de auditoría.
    expect(removed).toHaveLength(3);
    expect(removed.filter((line) => line.includes("v_inv.invited_by"))).toHaveLength(2);
  });

  it("NR3 · deshacer y volver a aplicar deja lo mismo", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      await db.query(downNewer);
      const before = {
        accept: await definition(ACCEPT_SIG),
        reconcile: await definition(RECONCILE_SIG),
      };
      await db.query(down);
      await db.query(up);
      expect({
        accept: await definition(ACCEPT_SIG),
        reconcile: await definition(RECONCILE_SIG),
      }).toEqual(before);
    }));

  describe("sin la migración, los problemas siguen ahí (lo que estas pruebas demuestran)", () => {
    /** Un Administrador (X) con su fila, activo en la organización A. */
    async function newAdmin(): Promise<{ user: TestUser; memberId: string }> {
      const user = await createUser(db, { meta: { full_name: "Admin Que Reenvía" } });
      await actAsPostgres(db);
      const { rows } = await db.query<{ id: string }>(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'admin') returning id",
        [w.tenantA, user.id],
      );
      return { user, memberId: rows[0].id };
    }

    /** El Dueño invita a un Comercial con la función real; devuelve lo necesario para reenviarla. */
    async function ownerInvites() {
      const id = randomUUID();
      const { sha } = newToken();
      const mailId = randomUUID();
      const email = `objetivo-${id.slice(0, 8)}@ejemplo.test`;
      await asUser(db, w.owner, w.tenantA);
      await db.query("select public.create_invitation($1, $2, $3, $4, $5, $6, $7, $8)", [
        id,
        `v1.cifrado.${id}`,
        sha256Hex(`huella|${email}`),
        invitationEmailBinding(sha, email),
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
      return { id, email };
    }

    /** X reenvía la invitación atada al correo del cómplice; el cómplice acepta. Devuelve el `invited_by` que queda. */
    async function resentByXAndAccepted(x: TestUser) {
      const accomplice = await createUser(db);
      const p = await ownerInvites();
      const stolen = newToken().sha;
      const mailId = randomUUID();
      await asUser(db, x, w.tenantA);
      await db.query("select public.resend_invitation($1, $2, $3, $4, $5)", [
        p.id,
        invitationEmailBinding(stolen, accomplice.email),
        stolen,
        mailId,
        `v1.cifrado.correo.${mailId}`,
      ]);
      await asUser(db, accomplice, w.tenantA);
      const accepted = (
        await db.query<{ r: { result: string } }>("select public.accept_invitation($1) as r", [
          stolen,
        ])
      ).rows[0].r;
      expect(accepted.result).toBe("accepted");
      await actAsPostgres(db);
      return (
        await db.query<{ invited_by: string }>(
          "select invited_by from public.members where tenant_id = $1 and user_id = $2",
          [w.tenantA, accomplice.id],
        )
      ).rows[0].invited_by;
    }

    it("NR4 · D3: sin la migración el miembro desviado figura a nombre del Dueño (el desvío queda oculto); con la migración, a nombre de quien reenvió", () =>
      withTx(db, async () => {
        await actAsPostgres(db);
        // Primero lo más nuevo: la función vigente es la de esta migración (sin la columna nueva).
        await db.query(downNewer);
        const x = await newAdmin();
        // Con la migración puesta.
        expect(await resentByXAndAccepted(x.user)).toBe(x.user.id);
        // Sin ella: el mismo camino deja al Dueño como quien invitó.
        await actAsPostgres(db);
        await db.query(down);
        expect(await resentByXAndAccepted(x.user)).toBe(w.owner.id);
        // Y al volver a aplicarla, otra vez queda a nombre de X.
        await actAsPostgres(db);
        await db.query(up);
        expect(await resentByXAndAccepted(x.user)).toBe(x.user.id);
      }));

    /**
     * Una invitación pendiente a mano: `send_count` 2, `resent_by` = X y dos correos con el MISMO `created_at` (solo pasa
     * si se crean en una misma transacción). El correo del Dueño tiene el id mayor o menor que el de X.
     */
    async function tiedInvitation(x: TestUser, ownerMail: "larger" | "smaller") {
      const p = await ownerInvites();
      await actAsPostgres(db);
      const first = (
        await db.query<{ id: string }>(
          "select id from public.email_messages where invitation_id = $1 and kind = 'invitation'",
          [p.id],
        )
      ).rows[0];
      let xMailId = randomUUID();
      while (xMailId < first.id === (ownerMail === "smaller")) xMailId = randomUUID();
      await db.query(
        `insert into public.email_messages
           (id, tenant_id, invitation_id, kind, to_email_enc, to_email_hash, provider, status, created_by, created_at)
         values ($1, $2, $3, 'invitation', $4, $5, 'pending', 'pending', $6,
                 (select m.created_at from public.email_messages m
                   where m.invitation_id = $3 and m.kind = 'invitation' order by m.created_at limit 1))`,
        [
          xMailId,
          w.tenantA,
          p.id,
          `v1.cifrado.correo.${xMailId}`,
          sha256Hex(`huella|${p.id}`),
          x.id,
        ],
      );
      await db.query("update public.invitations set send_count = 2, resent_by = $2 where id = $1", [
        p.id,
        x.id,
      ]);
      // El empate es de verdad: los dos correos tienen exactamente el mismo `created_at`.
      expect(
        await db
          .query(
            "select 1 from public.email_messages where invitation_id = $1 and kind = 'invitation' group by created_at",
            [p.id],
          )
          .then((r) => r.rowCount),
      ).toBe(1);
      return p;
    }
    const resentBy = async (id: string) =>
      (
        await db.query<{ resent_by: string | null }>(
          "select resent_by from public.invitations where id = $1",
          [id],
        )
      ).rows[0].resent_by;
    const removeAdmin = async (memberId: string) => {
      await asUser(db, w.owner, w.tenantA);
      const removed = (
        await db.query<{ r: { cancelled_invitations: number } }>(
          "select public.remove_member($1, 'admin') as r",
          [memberId],
        )
      ).rows[0].r;
      await actAsPostgres(db);
      return removed.cancelled_invitations;
    };

    it("NR5 · menor 1: sin la migración, repetir la limpieza pisa `resent_by` con el Dueño y quitar a X ya no cancela; con la migración no cambia nada", () =>
      withTx(db, async () => {
        await actAsPostgres(db);
        // Sin la migración (limpieza de #33): el correo del Dueño tiene el id mayor, que es el que ella elige.
        await db.query(down);
        const oldX = await newAdmin();
        const pOld = await tiedInvitation(oldX.user, "larger");
        for (let run = 0; run < 2; run++) {
          await actAsPostgres(db);
          await db.query("select app.reconcile_invitation_senders()");
        }
        expect(await resentBy(pOld.id), "la limpieza vieja pisa el dato").toBe(w.owner.id);
        expect(await removeAdmin(oldX.memberId), "ya no se cancela: el ataque se reabre").toBe(0);

        // Con la migración: el mismo montaje, con el id del Dueño mayor y menor (el de la limpieza nueva), no cambia.
        await actAsPostgres(db);
        await db.query(up);
        for (const ownerMail of ["larger", "smaller"] as const) {
          const x = await newAdmin();
          const p = await tiedInvitation(x.user, ownerMail);
          for (let run = 0; run < 2; run++) {
            await actAsPostgres(db);
            await db.query("select app.reconcile_invitation_senders()");
          }
          expect(await resentBy(p.id), ownerMail).toBe(x.user.id);
          expect(await removeAdmin(x.memberId), ownerMail).toBe(1);
        }
      }));

    /** Una invitación a mano con dos correos empatados: el de id menor y el de id mayor, con el estado que se indique. */
    async function twoMailsTied(opts: {
      lowBy: TestUser;
      lowStatus: "failed" | "pending";
      highBy: TestUser;
      highStatus: "failed" | "pending";
    }) {
      const id = randomUUID();
      const { sha } = newToken();
      const hash = sha256Hex(`huella|${id}`);
      await actAsPostgres(db);
      await db.query(
        `insert into public.invitations
           (id, tenant_id, email_enc, email_hash, email_binding, role, token_sha256, status, expires_at, invited_by,
            send_count, last_sent_at, owner_notice_state)
         values ($1, $2, $3, $4, $5, 'viewer', $6, 'pending', now() + interval '3 days', $7, 2, now(), 'none')`,
        [id, w.tenantA, `v1.cifrado.${id}`, hash, sha256Hex(`vinculo|${id}`), sha, w.owner.id],
      );
      const [low, high] = [randomUUID(), randomUUID()].sort();
      for (const [mailId, by, status] of [
        [low, opts.lowBy, opts.lowStatus],
        [high, opts.highBy, opts.highStatus],
      ] as const) {
        await db.query(
          `insert into public.email_messages
             (id, tenant_id, invitation_id, kind, to_email_enc, to_email_hash, provider, status, created_by, created_at)
           values ($1, $2, $3, 'invitation', $4, $5, 'pending', 'pending', $6, now())`,
          [mailId, w.tenantA, id, `v1.cifrado.correo.${mailId}`, hash, by.id],
        );
        if (status === "failed") {
          await db.query(
            "update public.email_messages set status = 'failed', error_code = 'test', status_at = now() where id = $1",
            [mailId],
          );
        }
      }
      return { id, sha };
    }
    /** Los argumentos de un reenvío (con un código y un vínculo nuevos), con la sesión del Dueño puesta. */
    const ownerResendParams = async (invitationId: string) => {
      const { sha } = newToken();
      const mailId = randomUUID();
      await asUser(db, w.owner, w.tenantA);
      return [
        invitationId,
        invitationEmailBinding(sha, "nuevo.destino@ejemplo.test"),
        sha,
        mailId,
        `v1.cifrado.correo.${mailId}`,
      ];
    };

    it("NR6 · menor 2: con un empate de `created_at`, la limpieza y el reenvío eligen el mismo correo (el de id menor), en las dos formas de empatar", () =>
      withTx(db, async () => {
        await actAsPostgres(db);
        const admin = w.admin;

        // (a) El de id menor es del Administrador y falló; el mayor es del Dueño y está pendiente y recién creado.
        const a = await twoMailsTied({
          lowBy: admin,
          lowStatus: "failed",
          highBy: w.owner,
          highStatus: "pending",
        });
        await actAsPostgres(db);
        await db.query("select app.reconcile_invitation_senders()");
        expect(await resentBy(a.id), "la limpieza elige el de id menor").toBe(admin.id);
        // El reenvío del Dueño pasa sin esperar el intervalo mínimo: eligió el correo que falló.
        const paramsA = await ownerResendParams(a.id);
        const resent = await db.query<{ r: { result: string } }>(
          "select public.resend_invitation($1, $2, $3, $4, $5) as r",
          paramsA,
        );
        expect(resent.rows[0].r.result).toBe("resent");

        // (b) Al invertir los estados, el menor queda pendiente y recién creado: la limpieza sigue eligiendo el id menor y
        //     el reenvío da «demasiado pronto» (porque también eligió el id menor).
        const b = await twoMailsTied({
          lowBy: admin,
          lowStatus: "pending",
          highBy: w.owner,
          highStatus: "failed",
        });
        await actAsPostgres(db);
        await db.query("select app.reconcile_invitation_senders()");
        expect(await resentBy(b.id)).toBe(admin.id);
        const paramsB = await ownerResendParams(b.id);
        const error = await expectSqlError(
          db,
          "select public.resend_invitation($1, $2, $3, $4, $5)",
          paramsB,
        );
        expect(error.code).toBe("CP429");
        expect(error.message).toContain("resend_too_soon");
      }));

    it("NR6b · guardia de texto: los dos cuerpos terminan el orden en `created_at desc, e.id`, sin `desc` al final", () =>
      withTx(db, async () => {
        await actAsPostgres(db);
        for (const [name, src] of [
          ["resend_invitation", (await definition(RESEND_SIG)).src],
          ["reconcile_invitation_senders", (await definition(RECONCILE_SIG)).src],
          ["texto de la migración", bodyIn(up, RECONCILE_SIG)],
        ]) {
          expect(src, name).toMatch(/e\.created_at desc, e\.id(?!\s+desc)/);
          expect(src, name).not.toMatch(/e\.id\s+desc/);
        }
      }));
  });
});
