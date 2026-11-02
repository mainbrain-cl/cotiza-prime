// Sprint 5 · migración 20261103100000 · aceptar una invitación (H-009).
// `invitation_preview` y `accept_invitation` con pases reales: correo que no coincide, vencida, cancelada, código
// viejo tras un reenvío, dos aceptaciones simultáneas con dos conexiones reales, aceptar mientras otro cancela,
// cuenta sin verificar, quien ya es miembro (conserva su rol), quien fue quitado (se reactiva con el rol de la
// invitación), los tres campos del correo vaciados, el aviso al Dueño intacto y el límite de aceptaciones fallidas.
// Cada prueba corre en una transacción que se deshace, salvo las de dos conexiones (usan su propia organización y
// dejan datos ficticios). Todo es ficticio.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationEmailBinding } from "../../src/lib/team/invitation-code";
import {
  actAs,
  actAsAnon,
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  expectSqlError,
  withTx,
  type TestUser,
} from "./helpers";
import { actAsService, asUser, buildWorld, newToken, sha256Hex, type World } from "./send-helpers";

let setup: Client;
let w: World;
beforeAll(async () => {
  setup = await connect();
  w = await buildWorld(setup);
});
afterAll(async () => {
  await setup.end();
});

type Json = Record<string, unknown>;
const CREATE = "select public.create_invitation($1, $2, $3, $4, $5, $6, $7, $8) as r";
const RESEND = "select public.resend_invitation($1, $2, $3, $4, $5) as r";
const REVOKE = "select public.revoke_invitation($1) as r";
const ACCEPT = "select public.accept_invitation($1) as r";
const PREVIEW = "select public.invitation_preview($1) as r";

// Las mismas constantes de la migración (app.invitation_accept_*): una prueba comprueba que no se separen.
const MAX_FAILURES = 10;
const NOT_AUTHENTICATED = "42501";
const INVALID = "CP422";
const NOT_ALLOWED_STATE = "CP423";

type Prepared = { id: string; email: string; tokenSha: string; params: unknown[] };

/** Los ocho argumentos de `create_invitation`, como los armaría la aplicación (el cifrado es de mentira). */
function prepare(email: string, role = "sales"): Prepared {
  const id = randomUUID();
  const hash = sha256Hex(`huella|${email.trim().toLowerCase()}`);
  const { sha } = newToken();
  const mailId = randomUUID();
  return {
    id,
    email,
    tokenSha: sha,
    params: [
      id,
      `v1.cifrado.${id}`,
      hash,
      invitationEmailBinding(sha, email),
      sha,
      role,
      mailId,
      `v1.cifrado.correo.${mailId}`,
    ],
  };
}

/** Invita (como `inviter`, en `tenant`) a `email` con `role`. Devuelve lo preparado: el id y la huella del código. */
async function inviteAs(inviter: TestUser, email: string, role = "sales", tenant = w.tenantA) {
  const p = prepare(email, role);
  await asUser(setup, inviter, tenant);
  const { rows } = await setup.query<{ r: Json }>(CREATE, p.params);
  await actAsPostgres(setup);
  expect(rows[0].r.result).toBe("created");
  return p;
}

/** Una cuenta nueva con el correo confirmado (o no). Siempre como postgres. */
async function newPerson(confirmed = true): Promise<TestUser> {
  await actAsPostgres(setup);
  return createUser(setup, { confirmed });
}

/** Llama una función de la base con el pase de la persona y SIN organización activa (aún no es miembro). */
async function asPerson(user: TestUser, sql: string, sha: string): Promise<Json> {
  await actAs(setup, user);
  const { rows } = await setup.query<{ r: Json }>(sql, [sha]);
  await actAsPostgres(setup);
  return rows[0].r;
}
const accept = (user: TestUser, sha: string) => asPerson(user, ACCEPT, sha);
const preview = (user: TestUser, sha: string) => asPerson(user, PREVIEW, sha);

const rowOf = async (id: string) => {
  await actAsPostgres(setup);
  return (await setup.query("select * from public.invitations where id = $1", [id])).rows[0];
};
const memberOf = async (tenant: string, user: TestUser) => {
  await actAsPostgres(setup);
  return (
    await setup.query("select * from public.members where tenant_id = $1 and user_id = $2", [
      tenant,
      user.id,
    ])
  ).rows[0];
};
const count = async (sql: string, params: unknown[] = []) => {
  await actAsPostgres(setup);
  return Number((await setup.query<{ n: string }>(sql, params)).rows[0].n);
};
const failuresOf = async (user: TestUser) => {
  await actAsPostgres(setup);
  const key = createHash("sha256").update(`invite_accept_user|${user.id}`).digest("hex");
  const { rows } = await setup.query<{ failures: number; locked: boolean }>(
    `select failures, coalesce(locked_until > now(), false) as locked from public.auth_rate_limits
      where scope = 'invite_accept_user' and key_hash = $1`,
    [key],
  );
  return rows[0] ?? { failures: 0, locked: false };
};
const randomSha = () => randomBytes(32).toString("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("quién puede llamarlas", () => {
  it("solo `authenticated`: ni anon ni público", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<{ fn: string; anon: boolean; auth: boolean; pub: boolean }>(
      `select f as fn,
              has_function_privilege('anon', f, 'execute') as anon,
              has_function_privilege('authenticated', f, 'execute') as auth,
              has_function_privilege('public', f, 'execute') as pub
         from unnest(array['public.accept_invitation(text)', 'public.invitation_preview(text)']) f`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.anon, `${row.fn} anon`).toBe(false);
      expect(row.pub, `${row.fn} público`).toBe(false);
      expect(row.auth, `${row.fn} authenticated`).toBe(true);
    }
  });

  it("sin sesión no se ejecutan (anon: permiso denegado)", () =>
    withTx(setup, async () => {
      await actAsAnon(setup);
      for (const sql of [ACCEPT, PREVIEW]) {
        const error = await expectSqlError(setup, sql, [randomSha()]);
        expect(error.code).toBe(NOT_AUTHENTICATED);
      }
    }));

  it("con el rol authenticated pero sin identidad en el pase tampoco", () =>
    withTx(setup, async () => {
      await actAsPostgres(setup);
      await setup.query(`select set_config('request.jwt.claims', '', true)`);
      await setup.query(`select set_config('request.jwt.claim.sub', '', true)`);
      await setup.query("set local role authenticated");
      for (const sql of [ACCEPT, PREVIEW]) {
        const error = await expectSqlError(setup, sql, [randomSha()]);
        expect(error.code).toBe(NOT_AUTHENTICATED);
      }
    }));

  it("el argumento tiene que ser una huella (64 hexadecimales)", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      for (const bad of ["", "abc", "A".repeat(64), "g".repeat(64), `${"a".repeat(63)}\n`]) {
        await actAs(setup, person);
        for (const sql of [ACCEPT, PREVIEW]) {
          const error = await expectSqlError(setup, sql, [bad]);
          expect(error.code, `${sql} con «${bad}»`).toBe(INVALID);
        }
      }
      await actAsPostgres(setup);
      expect(await failuresOf(person)).toEqual({ failures: 0, locked: false });
    }));

  it("`accept_invitation` recibe UN solo argumento: no hay forma de mandar un rol ni una organización", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<{ args: string; n: number }>(
      `select pg_get_function_arguments(p.oid) as args, p.pronargs as n
         from pg_proc p join pg_namespace s on s.oid = p.pronamespace
        where s.nspname = 'public' and p.proname = 'accept_invitation'`,
    );
    expect(rows).toEqual([{ args: "p_token_sha256 text", n: 1 }]);
  });

  it("corren con permisos elevados y fijan su ruta de búsqueda", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<{ proname: string; secdef: boolean; cfg: string[] | null }>(
      `select p.proname, p.prosecdef as secdef, p.proconfig as cfg
         from pg_proc p join pg_namespace s on s.oid = p.pronamespace
        where s.nspname = 'public' and p.proname in ('accept_invitation', 'invitation_preview')`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.secdef, row.proname).toBe(true);
      expect(row.cfg, row.proname).toContain('search_path=""');
    }
  });
});

describe("aceptar: el camino feliz", () => {
  it("crea la membresía con el rol de la INVITACIÓN, deja la invitación aceptada y vacía el correo", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "approver");
      const before = await rowOf(p.id);
      expect(before.email_enc).not.toBeNull();
      expect(before.email_hash).not.toBeNull();
      expect(before.email_binding).not.toBeNull();

      const result = await accept(person, p.tokenSha);
      expect(result).toEqual({
        result: "accepted",
        tenant_id: w.tenantA,
        role: "approver",
        already_member: false,
        reactivated: false,
      });

      const member = await memberOf(w.tenantA, person);
      expect(member).toMatchObject({ role: "approver", status: "active", invited_by: w.owner.id });
      expect(member.removed_at).toBeNull();

      const after = await rowOf(p.id);
      expect(after.status).toBe("accepted");
      expect(after.accepted_by).toBe(person.id);
      expect(after.accepted_at).not.toBeNull();
      expect(after.member_id).toBe(member.id);
      // El correo es un dato personal y ya vive en la cuenta: los TRES campos quedan vacíos.
      expect(after.email_enc).toBeNull();
      expect(after.email_hash).toBeNull();
      expect(after.email_binding).toBeNull();
      // Quién invitó, con qué rol y cuándo se conservan.
      expect(after.role).toBe("approver");
      expect(after.invited_by).toBe(w.owner.id);
    }));

  it.each(["admin", "approver", "sales", "viewer"])(
    "el rol «%s» de la invitación es el que queda",
    (role) =>
      withTx(setup, async () => {
        const person = await newPerson();
        const p = await inviteAs(w.owner, person.email, role);
        await accept(person, p.tokenSha);
        expect((await memberOf(w.tenantA, person)).role).toBe(role);
      }),
  );

  it("nadie queda como Dueño por aceptar: el Dueño sigue siendo único", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "admin");
      await accept(person, p.tokenSha);
      expect(
        await count(
          "select count(*) as n from public.members where tenant_id = $1 and role = 'owner' and status = 'active'",
          [w.tenantA],
        ),
      ).toBe(1);
    }));

  it("la organización queda en el selector de la persona (y solo esa)", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      await accept(person, p.tokenSha);
      await actAs(setup, person);
      const { rows } = await setup.query<{ tenant_id: string }>(
        "select tenant_id from public.members where user_id = $1 and status = 'active'",
        [person.id],
      );
      expect(rows.map((r) => r.tenant_id)).toEqual([w.tenantA]);
    }));

  it("deja `invitation.accepted` en la auditoría, sin el correo ni el código", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "sales");
      await accept(person, p.tokenSha);
      await actAsPostgres(setup);
      const { rows } = await setup.query<{
        action: string;
        actor_user_id: string;
        tenant_id: string;
        details: Json;
        resource_id: string;
      }>(
        `select action, actor_user_id, tenant_id, details, resource_id from public.audit_log
          where tenant_id = $1 and action = 'invitation.accepted'`,
        [w.tenantA],
      );
      const mine = rows.filter((r) => r.resource_id === p.id);
      expect(mine).toHaveLength(1);
      expect(mine[0].actor_user_id).toBe(person.id);
      expect(mine[0].details).toEqual({ role: "sales", already_member: false, reactivated: false });
      // Ni el correo ni el código ni su huella aparecen en NINGÚN registro de esta organización.
      const everything = JSON.stringify(
        (
          await setup.query(
            "select action, details, resource_id from public.audit_log where tenant_id = $1",
            [w.tenantA],
          )
        ).rows,
      );
      expect(everything).not.toContain(person.email);
      expect(everything).not.toContain(p.tokenSha);
    }));

  it("el correo de la cuenta se compara sin importar mayúsculas ni espacios", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      await actAsPostgres(setup);
      await setup.query("update auth.users set email = $2 where id = $1", [
        person.id,
        "Persona.Mixta@Ejemplo.TEST",
      ]);
      const p = await inviteAs(w.owner, "  persona.mixta@ejemplo.test ", "viewer");
      expect((await accept(person, p.tokenSha)).result).toBe("accepted");
    }));
});

describe("aceptar: lo que se rechaza", () => {
  it("con otro correo: «wrong_email», la invitación queda intacta y nadie entra", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const stranger = await newPerson();
      const p = await inviteAs(w.owner, person.email, "admin");
      const before = await rowOf(p.id);

      expect(await accept(stranger, p.tokenSha)).toEqual({ result: "wrong_email" });
      expect(await memberOf(w.tenantA, stranger)).toBeUndefined();
      const after = await rowOf(p.id);
      expect(after.status).toBe("pending");
      expect(after.email_binding).toBe(before.email_binding);
      expect(after.email_enc).toBe(before.email_enc);
      expect(after.accepted_by).toBeNull();
      // Y la persona correcta todavía puede usarla.
      expect((await accept(person, p.tokenSha)).result).toBe("accepted");
    }));

  it("un correo que se parece (otro dominio, otro usuario) tampoco sirve", () =>
    withTx(setup, async () => {
      const local = `ana.perez-${randomUUID().slice(0, 8)}`;
      const p = await inviteAs(w.owner, `${local}@ejemplo.test`, "viewer");
      for (const email of [
        `${local}@ejemplo.cl`,
        `${local}+x@ejemplo.test`,
        `${local.slice(0, -1)}@ejemplo.test`,
      ]) {
        const lookalike = await newPerson();
        await actAsPostgres(setup);
        await setup.query("update auth.users set email = $2 where id = $1", [lookalike.id, email]);
        expect((await accept(lookalike, p.tokenSha)).result, email).toBe("wrong_email");
      }
    }));

  it("el mensaje de «otro correo» no entrega ningún dato de la organización", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const stranger = await newPerson();
      const p = await inviteAs(w.owner, person.email, "admin");
      for (const fn of [accept, preview]) {
        const result = await fn(stranger, p.tokenSha);
        expect(Object.keys(result)).toEqual(["result"]);
      }
    }));

  it("un código que no existe: «not_found»", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      expect(await accept(person, randomSha())).toEqual({ result: "not_found" });
      expect(await preview(person, randomSha())).toEqual({ result: "not_found" });
    }));

  it("vencida: «expired», sin datos, y nadie entra", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      await actAsPostgres(setup);
      await setup.query(
        "update public.invitations set expires_at = now() - interval '1 second' where id = $1",
        [p.id],
      );
      expect(await accept(person, p.tokenSha)).toEqual({ result: "expired" });
      expect(await preview(person, p.tokenSha)).toEqual({ result: "expired" });
      expect(await memberOf(w.tenantA, person)).toBeUndefined();
      expect((await rowOf(p.id)).status).toBe("pending");
    }));

  it("en el último segundo de vigencia todavía vale", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      await actAsPostgres(setup);
      await setup.query(
        "update public.invitations set expires_at = now() + interval '2 seconds' where id = $1",
        [p.id],
      );
      expect((await accept(person, p.tokenSha)).result).toBe("accepted");
    }));

  it("cancelada: «revoked», sin datos, y nadie entra", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      await asUser(setup, w.owner, w.tenantA);
      await setup.query(REVOKE, [p.id]);
      await actAsPostgres(setup);
      expect(await accept(person, p.tokenSha)).toEqual({ result: "revoked" });
      expect(await preview(person, p.tokenSha)).toEqual({ result: "revoked" });
      expect(await memberOf(w.tenantA, person)).toBeUndefined();
      expect((await rowOf(p.id)).status).toBe("revoked");
    }));

  it("con el código viejo tras un reenvío: «not_found»; con el nuevo, entra", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      // Un reenvío genera un código nuevo; el intervalo mínimo no aplica si el último correo nunca salió.
      await actAsPostgres(setup);
      await setup.query(
        "update public.email_messages set status = 'failed', error_code = 'test', status_at = now() where invitation_id = $1",
        [p.id],
      );
      const fresh = newToken();
      await asUser(setup, w.owner, w.tenantA);
      const { rows } = await setup.query<{ r: Json }>(RESEND, [
        p.id,
        invitationEmailBinding(fresh.sha, person.email),
        fresh.sha,
        randomUUID(),
        `v1.cifrado.correo.${randomUUID()}`,
      ]);
      expect(rows[0].r.result).toBe("resent");
      await actAsPostgres(setup);

      expect(await accept(person, p.tokenSha)).toEqual({ result: "not_found" });
      expect(await memberOf(w.tenantA, person)).toBeUndefined();
      expect((await accept(person, fresh.sha)).result).toBe("accepted");
    }));

  it("usada por otra persona: «used», sin entregar la organización", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const other = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      expect((await accept(person, p.tokenSha)).result).toBe("accepted");
      expect(await accept(other, p.tokenSha)).toEqual({ result: "used" });
      expect(await preview(other, p.tokenSha)).toEqual({ result: "used" });
      expect(await memberOf(w.tenantA, other)).toBeUndefined();
    }));

  it("organización archivada: «archived», y nadie entra", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      await actAsPostgres(setup);
      await setup.query(
        "update public.tenants set status = 'archived', archived_at = now() where tenant_id = $1",
        [w.tenantA],
      );
      expect(await accept(person, p.tokenSha)).toEqual({ result: "archived" });
      expect(await preview(person, p.tokenSha)).toEqual({ result: "archived" });
      expect(await memberOf(w.tenantA, person)).toBeUndefined();
    }));

  it("si quien invitó ya no está en la organización, su invitación pendiente no vale", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.admin, person.email, "viewer");
      await actAsPostgres(setup);
      await setup.query(
        "update public.members set status = 'removed', removed_at = now(), removed_by = $3 where tenant_id = $1 and user_id = $2",
        [w.tenantA, w.admin.id, w.owner.id],
      );
      expect(await accept(person, p.tokenSha)).toEqual({ result: "inviter_inactive" });
      expect(await preview(person, p.tokenSha)).toEqual({ result: "inviter_inactive" });
      expect(await memberOf(w.tenantA, person)).toBeUndefined();
    }));

  it("si quien invitó ya no maneja el equipo (bajó a Observador), tampoco vale", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.admin, person.email, "viewer");
      await actAsPostgres(setup);
      await setup.query(
        "update public.members set role = 'viewer' where tenant_id = $1 and user_id = $2",
        [w.tenantA, w.admin.id],
      );
      expect(await accept(person, p.tokenSha)).toEqual({ result: "inviter_inactive" });
    }));

  it("una invitación que H-010 cancele por «inviter_removed» da el mismo resultado, sin datos", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.admin, person.email, "viewer");
      await actAsPostgres(setup);
      await setup.query(
        `update public.invitations set status = 'revoked', revoked_at = now(), revoke_reason = 'inviter_removed'
          where id = $1`,
        [p.id],
      );
      expect(await accept(person, p.tokenSha)).toEqual({ result: "inviter_inactive" });
      expect(await preview(person, p.tokenSha)).toEqual({ result: "inviter_inactive" });
      // Una cancelada de forma normal sigue siendo «revoked».
      const other = await newPerson();
      const q = await inviteAs(w.owner, other.email, "viewer");
      await asUser(setup, w.owner, w.tenantA);
      await setup.query(REVOKE, [q.id]);
      expect((await accept(other, q.tokenSha)).result).toBe("revoked");
    }));

  it("cuenta con el correo SIN verificar: «unverified», y no cuenta como intento fallido", () =>
    withTx(setup, async () => {
      const person = await newPerson(false);
      const p = await inviteAs(w.owner, person.email, "viewer");
      expect(await accept(person, p.tokenSha)).toEqual({ result: "unverified" });
      expect(await preview(person, p.tokenSha)).toEqual({ result: "unverified" });
      expect(await accept(person, randomSha())).toEqual({ result: "unverified" });
      expect(await memberOf(w.tenantA, person)).toBeUndefined();
      expect((await rowOf(p.id)).status).toBe("pending");
      expect(await failuresOf(person)).toEqual({ failures: 0, locked: false });
    }));

  it("un código de la organización B usado por una cuenta que no es la invitada no toca a B", () =>
    withTx(setup, async () => {
      const invitedInB = await newPerson();
      const p = await inviteAs(w.ownerB, invitedInB.email, "admin", w.tenantB);
      const intruder = await newPerson();
      const before = await rowOf(p.id);
      expect(await accept(intruder, p.tokenSha)).toEqual({ result: "wrong_email" });
      expect(await memberOf(w.tenantB, intruder)).toBeUndefined();
      expect(await rowOf(p.id)).toEqual(before);
      expect(
        await count("select count(*) as n from public.members where tenant_id = $1", [w.tenantB]),
      ).toBe(1);
    }));
});

describe("aceptar: quien ya estuvo o ya está", () => {
  it("quien ya es miembro conserva su rol; la invitación queda aceptada con su membresía", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "admin");
      // Entra a la organización por otro camino DESPUÉS de que le llegó la invitación.
      await actAsPostgres(setup);
      await setup.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'viewer')",
        [w.tenantA, person.id],
      );
      const existing = await memberOf(w.tenantA, person);

      const result = await accept(person, p.tokenSha);
      expect(result).toEqual({
        result: "accepted",
        tenant_id: w.tenantA,
        role: "viewer",
        already_member: true,
        reactivated: false,
      });
      const member = await memberOf(w.tenantA, person);
      expect(member.role).toBe("viewer"); // NO se subió a «admin»
      expect(member.id).toBe(existing.id);
      expect(
        await count(
          "select count(*) as n from public.members where tenant_id = $1 and user_id = $2",
          [w.tenantA, person.id],
        ),
      ).toBe(1);
      const after = await rowOf(p.id);
      expect(after.status).toBe("accepted");
      expect(after.member_id).toBe(existing.id);
    }));

  it("el Dueño que acepta una invitación a su propia organización sigue siendo Dueño", () =>
    withTx(setup, async () => {
      const p = await inviteAs(w.owner, "dueno.invitado@ejemplo.test", "viewer");
      // La invitación es para el correo del Dueño (la cuenta cambia de correo después de que la crearon).
      await actAsPostgres(setup);
      await setup.query(
        "update auth.users set email = 'dueno.invitado@ejemplo.test' where id = $1",
        [w.owner.id],
      );
      const result = await accept(w.owner, p.tokenSha);
      expect(result).toMatchObject({ result: "accepted", role: "owner", already_member: true });
      expect((await memberOf(w.tenantA, w.owner)).role).toBe("owner");
    }));

  it("quien fue quitado se reactiva en su MISMA fila, con el rol de la invitación", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      await actAsPostgres(setup);
      await setup.query(
        `insert into public.members (tenant_id, user_id, role, status, removed_at, removed_by)
         values ($1, $2, 'admin', 'removed', now() - interval '1 day', $3)`,
        [w.tenantA, person.id, w.owner.id],
      );
      const former = await memberOf(w.tenantA, person);
      const p = await inviteAs(w.owner, person.email, "sales");

      const result = await accept(person, p.tokenSha);
      expect(result).toEqual({
        result: "accepted",
        tenant_id: w.tenantA,
        role: "sales",
        already_member: false,
        reactivated: true,
      });
      const member = await memberOf(w.tenantA, person);
      expect(member.id).toBe(former.id);
      expect(member).toMatchObject({ status: "active", role: "sales", invited_by: w.owner.id });
      expect(member.removed_at).toBeNull();
      expect(member.removed_by).toBeNull();
      expect(
        await count(
          "select count(*) as n from public.members where tenant_id = $1 and user_id = $2",
          [w.tenantA, person.id],
        ),
      ).toBe(1);
      expect((await rowOf(p.id)).member_id).toBe(former.id);
    }));

  it("repetir el clic no falla: la misma persona sigue dentro y no se duplica nada", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "sales");
      expect((await accept(person, p.tokenSha)).result).toBe("accepted");
      const again = await accept(person, p.tokenSha);
      expect(again).toMatchObject({ result: "accepted", already_member: true, role: "sales" });
      expect(
        await count(
          "select count(*) as n from public.audit_log where action = 'invitation.accepted' and resource_id = $1",
          [p.id],
        ),
      ).toBe(1);
      // La vista previa de una invitación ya aceptada por ti te lleva a la organización.
      expect(await preview(person, p.tokenSha)).toEqual({
        result: "accepted",
        tenant_id: w.tenantA,
      });
    }));

  it("si la persona fue quitada después de aceptar, el mismo código ya no la deja volver", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "sales");
      await accept(person, p.tokenSha);
      await actAsPostgres(setup);
      await setup.query(
        "update public.members set status = 'removed', removed_at = now(), removed_by = $3 where tenant_id = $1 and user_id = $2",
        [w.tenantA, person.id, w.owner.id],
      );
      expect(await accept(person, p.tokenSha)).toEqual({ result: "used" });
      expect((await memberOf(w.tenantA, person)).status).toBe("removed");
    }));
});

describe("la vista previa", () => {
  it("si ya eres miembro activo, dice cuál es tu rol actual (aceptar no lo cambia)", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "admin");
      const fresh = await preview(person, p.tokenSha);
      expect(fresh).toMatchObject({
        result: "ok",
        already_member: false,
        current_role: null,
        role: "admin",
      });
      await actAsPostgres(setup);
      await setup.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'viewer')",
        [w.tenantA, person.id],
      );
      const member = await preview(person, p.tokenSha);
      expect(member).toMatchObject({
        result: "ok",
        already_member: true,
        current_role: "viewer",
        role: "admin",
      });
      // Y aceptar confirma lo que decía: el rol sigue siendo el actual.
      expect(await accept(person, p.tokenSha)).toMatchObject({
        role: "viewer",
        already_member: true,
      });
    }));

  it("quien fue quitado no figura como miembro: se le muestra el rol de la invitación, que sí recibirá", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      await actAsPostgres(setup);
      await setup.query(
        `insert into public.members (tenant_id, user_id, role, status, removed_at, removed_by)
         values ($1, $2, 'admin', 'removed', now(), $3)`,
        [w.tenantA, person.id, w.owner.id],
      );
      const p = await inviteAs(w.owner, person.email, "sales");
      expect(await preview(person, p.tokenSha)).toMatchObject({
        already_member: false,
        current_role: null,
        role: "sales",
      });
    }));

  it("para la cuenta invitada entrega organización, quién invitó, rol y vigencia", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "approver");
      await actAsPostgres(setup);
      const { rows } = await setup.query<{ name: string; full_name: string; expires_at: Date }>(
        `select t.name, pr.full_name, i.expires_at
           from public.invitations i
           join public.tenants t on t.tenant_id = i.tenant_id
           join public.profiles pr on pr.user_id = i.invited_by
          where i.id = $1`,
        [p.id],
      );
      const result = await preview(person, p.tokenSha);
      expect(result).toMatchObject({
        result: "ok",
        tenant_id: w.tenantA,
        tenant_name: rows[0].name,
        inviter_name: rows[0].full_name,
        role: "approver",
      });
      expect(new Date(result.expires_at as string).getTime()).toBe(rows[0].expires_at.getTime());
    }));

  it("no cambia nada: ni la invitación, ni la membresía", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      const before = await rowOf(p.id);
      await preview(person, p.tokenSha);
      expect(await rowOf(p.id)).toEqual(before);
      expect(await memberOf(w.tenantA, person)).toBeUndefined();
    }));
});

describe("el aviso al Dueño sale aunque la invitación ya esté aceptada", () => {
  it("aceptar no borra ni toca las filas `invitation_notice` ni `owner_notice_*`; los correos de la invitación siguen", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      // Un Administrador invita a otro Administrador: el aviso al Dueño queda anotado como pendiente.
      const p = await inviteAs(w.admin, person.email, "admin");
      const before = await rowOf(p.id);
      expect(before.owner_notice_state).toBe("pending");

      // Un intento del aviso ya reservado y anotado (fila de `email_messages` del aviso).
      await actAsService(setup);
      const reserved = (
        await setup.query<{ r: { invitation_ids: string[] } }>(
          "select public.invitation_notices_pending(5, $1) as r",
          [p.id],
        )
      ).rows[0].r;
      expect(reserved.invitation_ids).toEqual([p.id]);
      const noticeId = randomUUID();
      await setup.query("select public.invitation_notice_register($1, $2, $3, $4, $5)", [
        noticeId,
        p.id,
        w.owner.id,
        "v1.x.y",
        sha256Hex("dueno"),
      ]);
      await actAsPostgres(setup);
      const snapshot = async () => ({
        notices: (
          await setup.query(
            "select * from public.email_messages where invitation_id = $1 order by kind, id",
            [p.id],
          )
        ).rows,
        notice: (
          await setup.query(
            `select owner_notice_state, owner_notice_attempts, owner_notice_last_attempt_at
               from public.invitations where id = $1`,
            [p.id],
          )
        ).rows[0],
      });
      const mid = await snapshot();
      expect(mid.notices.filter((m) => m.kind === "invitation_notice")).toHaveLength(1);
      expect(mid.notices.filter((m) => m.kind === "invitation")).toHaveLength(1);

      expect((await accept(person, p.tokenSha)).result).toBe("accepted");
      // Idéntico: nada del aviso ni de los correos cambió.
      expect(await snapshot()).toEqual(mid);
    }));

  it("un aviso todavía pendiente (sin reservar) se puede reservar y enviar después de aceptar", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.admin, person.email, "admin");
      expect((await accept(person, p.tokenSha)).result).toBe("accepted");
      const after = await rowOf(p.id);
      expect(after.owner_notice_state).toBe("pending");
      expect(after.owner_notice_attempts).toBe(0);

      await actAsService(setup);
      const reserved = (
        await setup.query<{ r: { invitation_ids: string[] } }>(
          "select public.invitation_notices_pending(5, $1) as r",
          [p.id],
        )
      ).rows[0].r;
      expect(reserved.invitation_ids).toEqual([p.id]);
      const recipients = (
        await setup.query<{
          r: { invitation_status: string; role: string; recipients: { user_id: string }[] };
        }>("select public.invitation_notice_recipients($1) as r", [p.id])
      ).rows[0].r;
      expect(recipients.invitation_status).toBe("accepted");
      expect(recipients.role).toBe("admin");
      expect(recipients.recipients.map((r) => r.user_id)).toEqual([w.owner.id]);
      // El aviso no lleva el correo del invitado: la base ya no lo tiene para dárselo a nadie.
      expect(JSON.stringify(recipients)).not.toContain(person.email);
    }));

  it("los correos de una invitación aceptada se borran a los 30 días de aceptarse, no antes", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      await accept(person, p.tokenSha);
      await actAsPostgres(setup);
      const mails = () =>
        count("select count(*) as n from public.email_messages where invitation_id = $1", [p.id]);
      expect(await mails()).toBe(1);

      await setup.query("select app.purge_invitations()");
      expect(await mails()).toBe(1); // recién aceptada: nada se borra

      await setup.query(
        "update public.invitations set accepted_at = now() - interval '29 days' where id = $1",
        [p.id],
      );
      await setup.query("select app.purge_invitations()");
      expect(await mails()).toBe(1);

      await setup.query(
        "update public.invitations set accepted_at = now() - interval '31 days' where id = $1",
        [p.id],
      );
      await setup.query("select app.purge_invitations()");
      expect(await mails()).toBe(0);
      // La invitación aceptada se conserva como historia.
      expect((await rowOf(p.id)).status).toBe("accepted");
    }));
});

describe("el límite de aceptaciones fallidas", () => {
  it(`${MAX_FAILURES} fallos y la persona queda bloqueada: ni acierta con un código bueno`, () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const good = await inviteAs(w.owner, person.email, "viewer");
      for (let n = 1; n <= MAX_FAILURES; n++) {
        expect(await accept(person, randomSha()), `intento ${n}`).toEqual({ result: "not_found" });
      }
      expect(await failuresOf(person)).toEqual({ failures: MAX_FAILURES, locked: true });
      // Desde el undécimo, todo es «rate_limited»: también la vista previa y también un código bueno.
      expect(await accept(person, randomSha())).toEqual({ result: "rate_limited" });
      expect(await accept(person, good.tokenSha)).toEqual({ result: "rate_limited" });
      expect(await preview(person, good.tokenSha)).toEqual({ result: "rate_limited" });
      expect(await memberOf(w.tenantA, person)).toBeUndefined();
      expect((await rowOf(good.id)).status).toBe("pending");
    }));

  it("los 9 primeros fallos no bloquean", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const good = await inviteAs(w.owner, person.email, "viewer");
      for (let n = 1; n < MAX_FAILURES; n++) await accept(person, randomSha());
      expect(await failuresOf(person)).toEqual({ failures: MAX_FAILURES - 1, locked: false });
      expect((await accept(person, good.tokenSha)).result).toBe("accepted");
    }));

  it("probar un código ajeno con otro correo también cuenta", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const stranger = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      for (let n = 1; n <= MAX_FAILURES; n++) {
        expect((await accept(stranger, p.tokenSha)).result).toBe("wrong_email");
      }
      expect(await accept(stranger, p.tokenSha)).toEqual({ result: "rate_limited" });
      // El bloqueo es de ESA cuenta: la persona invitada entra sin problema.
      expect((await accept(person, p.tokenSha)).result).toBe("accepted");
    }));

  it("los estados definitivos (cancelada, vencida, usada) no cuentan como fallos", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      await asUser(setup, w.owner, w.tenantA);
      await setup.query(REVOKE, [p.id]);
      await actAsPostgres(setup);
      for (let n = 1; n <= MAX_FAILURES + 2; n++) {
        expect((await accept(person, p.tokenSha)).result).toBe("revoked");
      }
      expect(await failuresOf(person)).toEqual({ failures: 0, locked: false });
    }));

  it("el bloqueo termina: pasada la hora de desbloqueo, la persona vuelve a poder aceptar", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const good = await inviteAs(w.owner, person.email, "viewer");
      for (let n = 1; n <= MAX_FAILURES; n++) await accept(person, randomSha());
      expect((await accept(person, good.tokenSha)).result).toBe("rate_limited");
      await actAsPostgres(setup);
      await setup.query(
        `update public.auth_rate_limits set locked_until = now() - interval '1 second'
          where scope = 'invite_accept_user'
            and key_hash = $1`,
        [createHash("sha256").update(`invite_accept_user|${person.id}`).digest("hex")],
      );
      expect((await accept(person, good.tokenSha)).result).toBe("accepted");
    }));

  it("la clave del contador es una huella del id de la cuenta: ni el correo ni el id en claro", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      await accept(person, randomSha());
      await actAsPostgres(setup);
      const { rows } = await setup.query<{ key_hash: string }>(
        "select key_hash from public.auth_rate_limits where scope = 'invite_accept_user'",
      );
      const expected = createHash("sha256").update(`invite_accept_user|${person.id}`).digest("hex");
      expect(rows.map((r) => r.key_hash)).toContain(expected);
      for (const row of rows) {
        expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.key_hash).not.toContain(person.id.replaceAll("-", ""));
      }
    }));

  it("los fallos QUEDAN registrados aunque la aceptación no haya servido (no se deshacen con ella)", async () => {
    // Con dos transacciones reales: la primera falla y confirma; la segunda lee lo que quedó.
    await actAsPostgres(setup);
    await setup.query("begin");
    const person = await createUser(setup);
    await setup.query("commit");
    await setup.query("begin");
    await actAs(setup, person);
    const { rows } = await setup.query<{ r: Json }>(ACCEPT, [randomSha()]);
    expect(rows[0].r).toEqual({ result: "not_found" });
    await setup.query("commit");
    expect(await failuresOf(person)).toEqual({ failures: 1, locked: false });
    await actAsPostgres(setup);
    await setup.query("delete from public.auth_rate_limits where scope = 'invite_accept_user'");
  });

  it("los dos alcances nuevos existen en la tabla de límites", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conname = 'auth_rate_limits_scope_check'`,
    );
    expect(rows[0].def).toContain("invite_accept_user");
    expect(rows[0].def).toContain("invite_link_ip");
  });

  it("las constantes de la migración son las que esta prueba cree", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<{ max: number; win: number; lock: number }>(
      `select app.invitation_accept_max_failures() as max, app.invitation_accept_window_seconds() as win,
              app.invitation_accept_lock_seconds() as lock`,
    );
    expect(rows[0]).toEqual({ max: MAX_FAILURES, win: 600, lock: 600 });
  });
});

describe("dos conexiones reales a la vez", () => {
  /** Una organización propia y una persona invitada, confirmadas (las dos conexiones tienen que verlas). */
  async function committedInvitation() {
    await actAsPostgres(setup);
    await setup.query("begin");
    const owner = await createUser(setup);
    const invitee = await createUser(setup);
    const stranger = await createUser(setup);
    const tenant = await createTenantAs(setup, owner, "76086428-5", "Carrera de aceptaciones");
    await setup.query("commit");
    await setup.query("begin");
    const p = prepare(invitee.email, "approver");
    await asUser(setup, owner, tenant);
    await setup.query(CREATE, p.params);
    await setup.query("commit");
    await actAsPostgres(setup);
    return { owner, invitee, stranger, tenant, p };
  }

  /** Corre `body` dentro de una transacción de `client` y devuelve su resultado, confirmando al final. */
  async function inTx<T>(client: Client, body: () => Promise<T>, holdMs = 0): Promise<T> {
    await client.query("begin");
    try {
      const value = await body();
      if (holdMs) await sleep(holdMs); // se mantiene el candado un instante
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }

  it("la misma persona acepta dos veces a la vez: gana una, la otra ve que ya entró; un solo miembro y un solo registro", async () => {
    const { invitee, tenant, p } = await committedInvitation();
    const second = await connect();
    try {
      const run = (client: Client) =>
        inTx(
          client,
          async () => {
            await actAs(client, invitee);
            return (await client.query<{ r: Json }>(ACCEPT, [p.tokenSha])).rows[0].r;
          },
          150,
        );
      const results = await Promise.all([run(setup), run(second)]);
      expect(results.map((r) => r.result)).toEqual(["accepted", "accepted"]);
      expect(results.filter((r) => r.already_member === false)).toHaveLength(1);
      expect(results.filter((r) => r.already_member === true)).toHaveLength(1);
      expect(
        await count(
          "select count(*) as n from public.members where tenant_id = $1 and user_id = $2",
          [tenant, invitee.id],
        ),
      ).toBe(1);
      expect(
        await count(
          "select count(*) as n from public.audit_log where action = 'invitation.accepted' and resource_id = $1",
          [p.id],
        ),
      ).toBe(1);
      expect((await rowOf(p.id)).status).toBe("accepted");
    } finally {
      await actAsPostgres(setup);
      await second.end();
    }
  });

  it("la invitada y una desconocida a la vez: entra solo la invitada, la otra no entra", async () => {
    const { invitee, stranger, tenant, p } = await committedInvitation();
    const second = await connect();
    try {
      const run = (client: Client, who: TestUser) =>
        inTx(
          client,
          async () => {
            await actAs(client, who);
            return (await client.query<{ r: Json }>(ACCEPT, [p.tokenSha])).rows[0].r;
          },
          150,
        );
      const [mine, theirs] = await Promise.all([run(setup, invitee), run(second, stranger)]);
      expect(mine.result).toBe("accepted");
      expect(["wrong_email", "used"]).toContain(theirs.result);
      expect(await memberOf(tenant, stranger)).toBeUndefined();
      expect((await memberOf(tenant, invitee)).role).toBe("approver");
      expect((await rowOf(p.id)).accepted_by).toBe(invitee.id);
    } finally {
      await actAsPostgres(setup);
      await second.end();
    }
  });

  it("aceptar GANA el candado y cancelar llega después: la cancelación se rechaza y la persona queda dentro", async () => {
    const { owner, invitee, tenant, p } = await committedInvitation();
    const canceller = await connect();
    try {
      await setup.query("begin");
      await actAs(setup, invitee);
      expect((await setup.query<{ r: Json }>(ACCEPT, [p.tokenSha])).rows[0].r.result).toBe(
        "accepted",
      );
      // La aceptación está sin confirmar y tiene la invitación bloqueada: quien cancela tiene que esperar.
      await canceller.query("begin");
      await asUser(canceller, owner, tenant);
      let settled = false;
      const revoking = canceller
        .query(REVOKE, [p.id])
        .then(
          () => "revoked" as const,
          (error: { code?: string }) => error.code ?? "error",
        )
        .finally(() => {
          settled = true;
        });
      await sleep(250);
      expect(settled, "cancelar debía quedar esperando el candado").toBe(false);
      await setup.query("commit");
      expect(await revoking).toBe(NOT_ALLOWED_STATE);
      await canceller.query("rollback");
      await actAsPostgres(setup);
      const row = await rowOf(p.id);
      expect(row.status).toBe("accepted");
      expect(row.revoked_at).toBeNull();
      expect((await memberOf(tenant, invitee)).status).toBe("active");
    } finally {
      await setup.query("rollback").catch(() => undefined);
      await actAsPostgres(setup);
      await canceller.end();
    }
  });

  it("cancelar GANA el candado y aceptar llega después: «revoked», nadie entra y no hay estados a medias", async () => {
    const { owner, invitee, tenant, p } = await committedInvitation();
    const canceller = await connect();
    try {
      await canceller.query("begin");
      await asUser(canceller, owner, tenant);
      expect((await canceller.query<{ r: Json }>(REVOKE, [p.id])).rows[0].r.result).toBe("revoked");
      await setup.query("begin");
      await actAs(setup, invitee);
      let settled = false;
      const accepting = setup.query<{ r: Json }>(ACCEPT, [p.tokenSha]).finally(() => {
        settled = true;
      });
      await sleep(250);
      expect(settled, "aceptar debía quedar esperando el candado").toBe(false);
      await canceller.query("commit");
      expect((await accepting).rows[0].r).toEqual({ result: "revoked" });
      await setup.query("commit");
      await actAsPostgres(setup);
      const row = await rowOf(p.id);
      expect(row.status).toBe("revoked");
      expect(row.accepted_by).toBeNull();
      expect(row.accepted_at).toBeNull();
      expect(row.member_id).toBeNull();
      expect(row.email_binding).not.toBeNull();
      expect(await memberOf(tenant, invitee)).toBeUndefined();
    } finally {
      await setup.query("rollback").catch(() => undefined);
      await actAsPostgres(setup);
      await canceller.end();
    }
  });

  it("aceptar mientras otro reenvía (código nuevo): el código viejo ya no sirve", async () => {
    const { owner, invitee, tenant, p } = await committedInvitation();
    const resender = await connect();
    try {
      // El último correo de la invitación nunca salió: se puede reenviar sin esperar el intervalo mínimo.
      await setup.query("begin");
      await setup.query(
        "update public.email_messages set status = 'failed', error_code = 'test', status_at = now() where invitation_id = $1",
        [p.id],
      );
      await setup.query("commit");
      const fresh = newToken();
      await resender.query("begin");
      await asUser(resender, owner, tenant);
      const { rows } = await resender.query<{ r: Json }>(RESEND, [
        p.id,
        invitationEmailBinding(fresh.sha, invitee.email),
        fresh.sha,
        randomUUID(),
        `v1.cifrado.correo.${randomUUID()}`,
      ]);
      expect(rows[0].r.result).toBe("resent");
      await setup.query("begin");
      await actAs(setup, invitee);
      let settled = false;
      const accepting = setup.query<{ r: Json }>(ACCEPT, [p.tokenSha]).finally(() => {
        settled = true;
      });
      await sleep(250);
      expect(settled).toBe(false);
      await resender.query("commit");
      // El código viejo ya no existe cuando se libera el candado.
      expect((await accepting).rows[0].r).toEqual({ result: "not_found" });
      await setup.query("commit");
      await actAsPostgres(setup);
      expect(await memberOf(tenant, invitee)).toBeUndefined();
      await setup.query("begin");
      expect((await accept(invitee, fresh.sha)).result).toBe("accepted");
      await setup.query("commit");
    } finally {
      await setup.query("rollback").catch(() => undefined);
      await actAsPostgres(setup);
      await resender.end();
    }
  });
});

describe("solo lectura: un GET de PostgREST no puede probar códigos", () => {
  it("las dos funciones se niegan (25006) en una transacción de solo lectura y no cuentan ni cambian nada", async () => {
    await actAsPostgres(setup);
    await setup.query("begin");
    try {
      const person = await createUser(setup);
      const p = await inviteAs(w.owner, person.email, "viewer");
      await asUser(setup, w.owner, w.tenantA);
      await setup.query(REVOKE, [p.id]);
      await actAsPostgres(setup);
      // Desde aquí la transacción es de solo lectura, como la de un GET de PostgREST. Con una invitación cancelada
      // las funciones NO escribirían nada: si igual contestan, es que se saltaron el límite de intentos.
      await setup.query("set transaction read only");
      for (const sql of [ACCEPT, PREVIEW]) {
        await actAs(setup, person);
        const error = await expectSqlError(setup, sql, [p.tokenSha]);
        expect(error.code, sql).toBe("25006");
      }
      await actAs(setup, person);
      const wrong = await expectSqlError(setup, ACCEPT, [randomSha()]);
      expect(wrong.code).toBe("25006");
    } finally {
      await setup.query("rollback");
    }
  });
});

describe("la auditoría de quien prueba un código con otro correo (invitation.accept_denied)", () => {
  type AuditRow = {
    action: string;
    result: string;
    tenant_id: string;
    actor_user_id: string;
    resource_id: string;
    details: Json;
  };
  const deniedBy = async (user: TestUser): Promise<AuditRow[]> => {
    await actAsPostgres(setup);
    return (
      await setup.query<AuditRow>(
        `select action, result, tenant_id, actor_user_id, resource_id, details from public.audit_log
          where action = 'invitation.accept_denied' and actor_user_id = $1 order by id`,
        [user.id],
      )
    ).rows;
  };

  it("se registra en la organización de la invitación, como «denied», sin el correo ni el código", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const stranger = await newPerson();
      const p = await inviteAs(w.ownerB, person.email, "admin", w.tenantB);
      expect((await accept(stranger, p.tokenSha)).result).toBe("wrong_email");
      expect((await preview(stranger, p.tokenSha)).result).toBe("wrong_email");
      const rows = await deniedBy(stranger);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({
          result: "denied",
          tenant_id: w.tenantB,
          actor_user_id: stranger.id,
          resource_id: p.id,
        });
      }
      expect(rows.map((r) => r.details)).toEqual([
        { reason: "wrong_email", step: "accept" },
        { reason: "wrong_email", step: "preview" },
      ]);
      const everything = JSON.stringify(rows);
      for (const secret of [person.email, stranger.email, p.tokenSha, "@ejemplo.test"]) {
        expect(everything).not.toContain(secret);
      }
      // No aparece en la auditoría de ninguna otra organización.
      expect(
        await count(
          "select count(*) as n from public.audit_log where action = 'invitation.accept_denied' and tenant_id <> $1 and actor_user_id = $2",
          [w.tenantB, stranger.id],
        ),
      ).toBe(0);
    }));

  it("la ve quien maneja el equipo de ESA organización y nadie de otra", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const stranger = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      await accept(stranger, p.tokenSha);
      const read = async (user: TestUser, tenant: string) => {
        await asUser(setup, user, tenant);
        const { rows } = await setup.query<{ n: string }>(
          "select count(*) as n from public.audit_log where action = 'invitation.accept_denied' and actor_user_id = $1",
          [stranger.id],
        );
        await actAsPostgres(setup);
        return Number(rows[0].n);
      };
      expect(await read(w.owner, w.tenantA)).toBe(1);
      expect(await read(w.ownerB, w.tenantB)).toBe(0);
    }));

  it("no se registra para un código inventado (no hay organización), ni cuando la cuenta ya está bloqueada", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const stranger = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      for (let n = 0; n < 3; n++) await accept(stranger, randomSha());
      expect(await deniedBy(stranger)).toHaveLength(0);
      // Hasta el tope se registra cada intento; pasado el tope (la cuenta bloqueada) ya no se escribe nada:
      // la auditoría no puede crecer más rápido que el límite de fallos.
      for (let n = 0; n < MAX_FAILURES + 5; n++) await accept(stranger, p.tokenSha);
      expect(await failuresOf(stranger)).toMatchObject({ locked: true });
      const rows = await deniedBy(stranger);
      expect(rows).toHaveLength(MAX_FAILURES - 3);
      expect(await accept(stranger, p.tokenSha)).toEqual({ result: "rate_limited" });
      expect(await deniedBy(stranger)).toHaveLength(MAX_FAILURES - 3);
    }));

  it("tampoco se registra cuando el correo sí coincide ni en los otros fallos (vencida, cancelada, usada)", () =>
    withTx(setup, async () => {
      const person = await newPerson();
      const p = await inviteAs(w.owner, person.email, "viewer");
      await preview(person, p.tokenSha);
      await accept(person, p.tokenSha);
      const other = await newPerson();
      expect((await accept(other, p.tokenSha)).result).toBe("used");
      expect(await deniedBy(person)).toHaveLength(0);
      expect(await deniedBy(other)).toHaveLength(0);
    }));
});
