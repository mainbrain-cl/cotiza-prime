// H-010 · menores 1 y 4 de la revisión de Aarón al PR #35 (2026-11-09) · migración 20261109120000_member_invitation_creator.
// Cambia dos cosas y nada más:
//   · `members.invitation_created_by` (columna nueva, nulable, con referencia a `auth.users`) guarda quién CREÓ la
//     invitación aceptada, además de `members.invited_by` (quien envió el enlace por última vez);
//   · `accept_invitation` es copia literal de la de 20261109100000 con las líneas que escriben esa columna.
// Y fija la regla de `lock_timeout`: la primera sentencia de la migración y de su deshacer es `set local lock_timeout = '3s'`.
// Aquí se prueba que el «deshacer» devuelve la función EXACTAMENTE a su texto anterior y borra la columna, que se puede
// volver a aplicar, que se niega a correr si otra función usa la columna, que el cambio hace lo que dice y que el tope de
// espera funciona. Se ejecutan los archivos reales dentro de una transacción que se deshace (salvo el bloqueo de MC6, que
// usa dos conexiones); el deshacer completo y en orden lo prueba `npm run test:db:rollbacks`. Todo es ficticio.
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
import { functionBodyIn } from "./migration-files";
import { asUser, buildWorld, newToken, sha256Hex, type World } from "./send-helpers";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "supabase");
const NAME = "20261109120000_member_invitation_creator";
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");
const up = read("migrations", `${NAME}.sql`);
const down = read("rollbacks", `${NAME}.down.sql`);
/** La migración anterior que define `accept_invitation` (D3): a su texto vuelve el deshacer. */
const d3Migration = read("migrations", "20261109100000_invitation_accept_sender.sql");
/** El deshacer de D3 (lo siguiente que se deshace después de este): deja `accept_invitation` como la de H-009. */
const d3Down = read("rollbacks", "20261109100000_invitation_accept_sender.down.sql");

const ACCEPT_SIG = "public.accept_invitation(text)";
/** Lo mismo que `MIGRATION_LOCK_TIMEOUT` de schema-guards.test.ts. */
const LOCK_TIMEOUT_SECONDS = 3;

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

const hasColumn = async (): Promise<boolean> =>
  (
    await db.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'members' and column_name = 'invitation_created_by'`,
    )
  ).rowCount === 1;

/** El SQL sin los comentarios de línea entera. */
const code = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
/** El SQL sin comentarios y con los espacios y saltos de línea colapsados en uno. */
const flat = (sql: string) => code(sql).replace(/\s+/g, " ").trim();
const firstStatement = (sql: string) => flat(sql).split(";")[0].trim();

/**
 * `creator` crea una invitación (a un Comercial) y `resender` la reenvía; devuelve el correo y el código vigentes. Con
 * `creator` distinto de `resender` la membresía queda con `invited_by` = `resender` e `invitation_created_by` = `creator`.
 */
async function invitationCreatedBy(creator: TestUser, resender: TestUser) {
  const person = await createUser(db);
  const id = randomUUID();
  const created = newToken().sha;
  const mailId = randomUUID();
  await asUser(db, creator, w.tenantA);
  await db.query("select public.create_invitation($1, $2, $3, $4, $5, $6, $7, $8)", [
    id,
    `v1.cifrado.${id}`,
    sha256Hex(`huella|${person.email}`),
    invitationEmailBinding(created, person.email),
    created,
    "sales",
    mailId,
    `v1.cifrado.correo.${mailId}`,
  ]);
  await actAsPostgres(db);
  await db.query(
    "update public.invitations set last_sent_at = now() - interval '1 hour' where id = $1",
    [id],
  );
  const fresh = newToken().sha;
  const resendMail = randomUUID();
  await asUser(db, resender, w.tenantA);
  await db.query("select public.resend_invitation($1, $2, $3, $4, $5)", [
    id,
    invitationEmailBinding(fresh, person.email),
    fresh,
    resendMail,
    `v1.cifrado.correo.${resendMail}`,
  ]);
  await actAsPostgres(db);
  return { person, id, sha: fresh };
}

/** La persona acepta; devuelve la fila de `members` que queda (como postgres). */
async function acceptAndRead(person: TestUser, sha: string): Promise<Record<string, unknown>> {
  await asUser(db, person, w.tenantA);
  const { rows } = await db.query<{ r: { result: string } }>(
    "select public.accept_invitation($1) as r",
    [sha],
  );
  expect(rows[0].r.result).toBe("accepted");
  await actAsPostgres(db);
  return (
    await db.query("select * from public.members where tenant_id = $1 and user_id = $2", [
      w.tenantA,
      person.id,
    ])
  ).rows[0];
}

describe("la migración member_invitation_creator y su deshacer", () => {
  it("MC1 · forma de los archivos: `lock_timeout` es la primera sentencia de los dos, solo se redefine `accept_invitation` y el deshacer no borra nada más que la columna", () => {
    expect(firstStatement(up)).toBe(`set local lock_timeout = '${LOCK_TIMEOUT_SECONDS}s'`);
    expect(firstStatement(down)).toBe(`set local lock_timeout = '${LOCK_TIMEOUT_SECONDS}s'`);
    // Solo se redefine una función, y es `accept_invitation`, en la migración y en el deshacer.
    for (const [name, sql] of [
      ["migración", up],
      ["deshacer", down],
    ] as const) {
      const defined = [...code(sql).matchAll(/create (?:or replace )?function ([a-z_.]+)\(/gi)].map(
        (m) => m[1],
      );
      expect(defined, name).toEqual(["public.accept_invitation"]);
      expect(code(sql), name).toMatch(
        /revoke all on function public\.accept_invitation\(text\) from public, anon, authenticated;/,
      );
      expect(code(sql), name).toMatch(
        /grant execute on function public\.accept_invitation\(text\) to authenticated;/,
      );
    }
    // La migración solo agrega una columna (sin default, sin índice, sin restricción propia) y la comenta.
    expect(code(up)).toMatch(
      /alter table public\.members add column invitation_created_by uuid references auth\.users \(id\);/,
    );
    expect(code(up)).not.toMatch(/\b(create\s+(unique\s+)?index|default|not null|drop)\b/i);
    // El deshacer no borra ni cambia datos ni objetos, salvo la columna.
    const downCode = code(down);
    expect(downCode.match(/\bdrop\b/gi)).toHaveLength(1);
    expect(downCode).toContain(
      "alter table public.members drop column if exists invitation_created_by;",
    );
    expect(downCode).not.toMatch(/\b(truncate|delete\s+from)\b/i);
  });

  it("MC2 · la función vigente es la del archivo; tras el deshacer es EXACTAMENTE la de D3, con los mismos atributos y permisos, y la columna desaparece", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      expect(await hasColumn()).toBe(true);
      const current = await definition(ACCEPT_SIG);
      expect(current.src).toBe(functionBodyIn(up, "public.accept_invitation"));
      expect(current.src).toContain("invitation_created_by = v_inv.invited_by");
      expect(current.src).toContain("v_sender, v_inv.invited_by)");

      await db.query(down);

      expect(await hasColumn()).toBe(false);
      const restored = await definition(ACCEPT_SIG);
      expect(restored.src).toBe(functionBodyIn(d3Migration, "public.accept_invitation"));
      expect(restored.src).not.toContain("invitation_created_by");
      expect(withoutSrc(restored)).toEqual(withoutSrc(current));
      expect(restored).toMatchObject({ secdef: true, anon: false, pub: false, auth: true });
      expect(restored.cfg).toContain('search_path=""');
    }));

  it("MC2b · respecto de la de D3, lo nuevo son solo comentarios y la columna `invitation_created_by`; desaparecen exactamente tres líneas (las que escriben en `members`)", () => {
    const trimmed = (sql: string) =>
      new Set(
        functionBodyIn(sql, "public.accept_invitation")
          .split("\n")
          .map((line) => line.trim()),
      );
    const before = trimmed(d3Migration);
    const after = trimmed(up);
    const added = [...after].filter((line) => !before.has(line));
    const removed = [...before].filter((line) => !after.has(line));
    for (const line of added) {
      expect(line, "línea nueva fuera de lo anunciado").toMatch(
        /^--|invitation_created_by|^joined_at = now\(\), invited_by = v_sender,$|^values \(v_inv\.tenant_id, v_uid, v_inv\.role, 'active', v_sender, v_inv\.invited_by\)$/,
      );
    }
    expect(removed).toEqual([
      "joined_at = now(), invited_by = v_sender",
      "insert into public.members (tenant_id, user_id, role, status, invited_by)",
      "values (v_inv.tenant_id, v_uid, v_inv.role, 'active', v_sender)",
    ]);
    // Y quitando esas piezas, el código (sin comentarios) es idéntico al de D3: no cambió nada más.
    const withoutNew = flat(functionBodyIn(up, "public.accept_invitation"))
      .replace(", invitation_created_by = v_inv.invited_by", "")
      .replace(", invitation_created_by)", ")")
      .replace(", v_sender, v_inv.invited_by)", ", v_sender)");
    expect(withoutNew).toBe(flat(functionBodyIn(d3Migration, "public.accept_invitation")));
  });

  it("MC3 · deshacer y volver a aplicar deja lo mismo; la columna es uuid, nulable, sin valor por defecto y con referencia a auth.users(id); lo aceptado con la migración deshecha queda vacío", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const before = await definition(ACCEPT_SIG);
      const shape = async () =>
        (
          await db.query<{
            data_type: string;
            is_nullable: string;
            column_default: string | null;
            fk: string | null;
            comment: string | null;
          }>(
            `select c.data_type, c.is_nullable, c.column_default,
                    (select pg_get_constraintdef(k.oid) from pg_constraint k
                      where k.conrelid = 'public.members'::regclass and k.contype = 'f'
                        and k.conkey = array[a.attnum]) as fk,
                    col_description('public.members'::regclass, a.attnum) as comment
               from information_schema.columns c
               join pg_attribute a on a.attrelid = 'public.members'::regclass and a.attname = c.column_name
              where c.table_schema = 'public' and c.table_name = 'members'
                and c.column_name = 'invitation_created_by'`,
          )
        ).rows[0];
      const original = await shape();
      expect(original).toMatchObject({
        data_type: "uuid",
        is_nullable: "YES",
        column_default: null,
        fk: "FOREIGN KEY (invitation_created_by) REFERENCES auth.users(id)",
      });
      expect(original.comment).toContain("Quién creó la invitación");

      await db.query(down);
      // Con la migración deshecha, aceptar sigue funcionando (D3) y no hay columna que llenar.
      const { person, sha } = await invitationCreatedBy(w.admin, w.owner);
      const member = await acceptAndRead(person, sha);
      expect(member).not.toHaveProperty("invitation_created_by");
      expect(member.invited_by).toBe(w.owner.id);

      await db.query(up);
      expect(await definition(ACCEPT_SIG)).toEqual(before);
      expect(await shape()).toEqual(original);
      // La fila aceptada mientras estaba deshecha queda vacía al reaplicar (no se rellena).
      const after = (
        await db.query<{ invitation_created_by: string | null }>(
          "select invitation_created_by from public.members where tenant_id = $1 and user_id = $2",
          [w.tenantA, person.id],
        )
      ).rows[0];
      expect(after.invitation_created_by).toBeNull();
    }));

  it("MC4 · con la migración se guarda quien creó la invitación (distinto de quien la envió); deshecha, D3 se mantiene; reaplicada, se vuelve a guardar", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      // El Administrador crea y el Dueño reenvía: creó = Administrador, envió = Dueño.
      const first = await invitationCreatedBy(w.admin, w.owner);
      const withMigration = await acceptAndRead(first.person, first.sha);
      expect(withMigration.invited_by, "quien envió el enlace").toBe(w.owner.id);
      expect(withMigration.invitation_created_by, "quien creó la invitación").toBe(w.admin.id);

      await db.query(down);
      const second = await invitationCreatedBy(w.admin, w.owner);
      const withoutMigration = await acceptAndRead(second.person, second.sha);
      expect(withoutMigration.invited_by, "D3 se mantiene sin la migración").toBe(w.owner.id);

      await db.query(up);
      const third = await invitationCreatedBy(w.admin, w.owner);
      const again = await acceptAndRead(third.person, third.sha);
      expect(again.invited_by).toBe(w.owner.id);
      expect(again.invitation_created_by).toBe(w.admin.id);
    }));

  it("MC5 · el deshacer se niega a correr si otra función usa la columna, la nombra y no cambia nada; sin ella, o con otra que solo tiene `p_invitation_created_by`, pasa", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      // Un parámetro llamado `p_invitation_created_by` NO cuenta: se busca la columna como palabra entera.
      await db.query(
        `create function app.mc5_harmless(p_invitation_created_by uuid) returns uuid language sql immutable
           set search_path = '' as $$ select p_invitation_created_by $$`,
      );
      await db.query(
        `create function app.mc5_reader() returns uuid language sql stable
           set search_path = '' as $$ select m.invitation_created_by from public.members m limit 1 $$`,
      );
      const before = await definition(ACCEPT_SIG);
      const refused = await expectSqlError(db, down);
      expect(refused.message).toContain("app.mc5_reader(");
      expect(refused.message).not.toContain("mc5_harmless");
      // `accept_invitation` es la excepción: este mismo archivo la devuelve a su texto anterior.
      expect(refused.message).not.toContain("accept_invitation");
      expect(await hasColumn()).toBe(true);
      expect(await definition(ACCEPT_SIG)).toEqual(before);

      await db.query("drop function app.mc5_reader()");
      await db.query(down);
      expect(await hasColumn()).toBe(false);
    }));

  it("MC7 · el deshacer se niega a reponer la función de D3 si la vigente no es la de esta migración (ya se deshizo, o D3 también); en el estado normal pasa", () =>
    withTx(db, async () => {
      await actAsPostgres(db);
      const refusal =
        "la funcion public.accept_invitation vigente ya no nombra invitation_created_by";
      // Estado normal: la vigente es la de esta migración, el deshacer corre.
      expect((await definition(ACCEPT_SIG)).src).toContain("invitation_created_by");
      await db.query(down);
      expect(await hasColumn()).toBe(false);
      // (a) Con la función de D3 puesta (este deshacer ya corrió), repetirlo se niega, con el mensaje claro.
      const again = await expectSqlError(db, down);
      expect(again.message).toContain(refusal);
      expect(again.message).toContain("revise el orden de los deshacer");
      // (b) Con la de H-009 puesta (se deshizo también D3), lo mismo: repondría una función que lee una columna que ya no existe.
      await db.query(d3Down);
      const older = await expectSqlError(db, down);
      expect(older.message).toContain(refusal);
      // La negativa no cambió nada: sigue la función de H-009 (sin `v_sender`).
      expect((await definition(ACCEPT_SIG)).src).not.toContain("v_sender");
      // (c) Reaplicando en orden (D3 y luego esta), vuelve al estado normal y el deshacer pasa otra vez.
      await db.query(d3Migration);
      await db.query(up);
      await db.query(down);
      expect(await hasColumn()).toBe(false);
    }));

  it("MC6 · `lock_timeout` vale 3 s dentro de la transacción del archivo (y no se queda después), y si otra conexión sostiene un bloqueo sobre `members`, el deshacer falla con 55P03 en unos 3 s", async () => {
    const holder = await connect();
    try {
      // (a) El valor: lo fija cada archivo, solo hasta el fin de su transacción.
      await db.query("begin");
      try {
        await db.query(down);
        expect(
          (await db.query<{ lock_timeout: string }>("show lock_timeout")).rows[0].lock_timeout,
        ).toBe(`${LOCK_TIMEOUT_SECONDS}s`);
        await db.query(up);
        expect(
          (await db.query<{ lock_timeout: string }>("show lock_timeout")).rows[0].lock_timeout,
        ).toBe(`${LOCK_TIMEOUT_SECONDS}s`);
      } finally {
        await db.query("rollback");
      }
      expect(
        (await db.query<{ lock_timeout: string }>("show lock_timeout")).rows[0].lock_timeout,
      ).toBe("0");

      // (b) Otra conexión tiene `members` bloqueada para escribir: el deshacer necesita el bloqueo más fuerte y se rinde.
      await holder.query("begin");
      await holder.query("lock table public.members in share mode");
      await db.query("begin");
      const started = Date.now();
      let code: string | undefined;
      try {
        await db.query(down);
      } catch (error) {
        code = (error as { code?: string }).code;
      } finally {
        await db.query("rollback");
      }
      const waited = Date.now() - started;
      expect(code, "debía rendirse por el bloqueo").toBe("55P03");
      expect(waited).toBeGreaterThanOrEqual(LOCK_TIMEOUT_SECONDS * 1000 - 300);
      expect(waited).toBeLessThan(LOCK_TIMEOUT_SECONDS * 1000 + 2500);
      // No quedó nada a medias: la columna y la función nueva siguen ahí.
      await holder.query("rollback");
      await actAsPostgres(db);
      expect(await hasColumn()).toBe(true);
      expect((await definition(ACCEPT_SIG)).src).toBe(
        functionBodyIn(up, "public.accept_invitation"),
      );
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
  });
});
