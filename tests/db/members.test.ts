// Sprint 5 · migración 20261105110000 · cambiar el rol de un miembro o quitarlo (H-010).
// `list_members`, `change_member_role` y `remove_member` con pases reales de cada rol: quién puede, el Dueño y uno
// mismo intocables (el Dueño, sin bloquear su fila), solo el Dueño da o quita un rol que maneja el equipo, tope de
// cambios por hora (cambios de rol y quitadas sumados; el Dueño sin tope), otra
// organización, rol esperado desactualizado, el Dueño quita a un Administrador mientras este actúa, dos cambios
// simultáneos al mismo miembro, invitar o reenviar mientras te quitan, invitaciones canceladas, nombre todavía
// visible, filas de quien se fue solo para quien maneja el equipo, ex miembro sin acceso a nada, reactivar por
// invitación y escritura directa en `members` rechazada.
// Cada prueba corre en una transacción que se deshace, salvo las de dos conexiones (usan su propia organización y
// dejan datos ficticios). Todo es ficticio.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationEmailBinding } from "../../src/lib/team/invitation-code";
import {
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  expectSqlError,
  withTx,
  type TestUser,
} from "./helpers";
import { insertRequest, makeForm } from "./intake-helpers";
import { asUser, buildWorld, createQuote, newToken, sha256Hex, type World } from "./send-helpers";

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
const LIST = "select public.list_members() as r";
const CHANGE = "select public.change_member_role($1, $2, $3) as r";
const REMOVE = "select public.remove_member($1, $2) as r";
const CREATE_INVITATION = "select public.create_invitation($1, $2, $3, $4, $5, $6, $7, $8) as r";
const RESEND = "select public.resend_invitation($1, $2, $3, $4, $5) as r";
const ACCEPT = "select public.accept_invitation($1) as r";

const INSUFFICIENT_PRIVILEGE = "42501";
const NOT_FOUND = "CP404";
const CONFLICT = "CP409";
const INVALID = "CP422";
const NOT_ALLOWED = "CP423";
const TOO_MANY = "CP429";
/** El tope de `app.member_change_max_per_hour()`: cambios de rol y quitadas, sumados. */
const MEMBER_CHANGES_PER_HOUR = 30;

async function call<T = Json>(user: TestUser, tenant: string, sql: string, params: unknown[] = []) {
  await asUser(setup, user, tenant);
  const { rows } = await setup.query<{ r: T }>(sql, params);
  await actAsPostgres(setup);
  return rows[0].r;
}

async function denied(user: TestUser, tenant: string, sql: string, params: unknown[] = []) {
  await asUser(setup, user, tenant);
  const error = await expectSqlError(setup, sql, params);
  await actAsPostgres(setup);
  return error;
}

const count = async (sql: string, params: unknown[] = []) => {
  await actAsPostgres(setup);
  return Number((await setup.query<{ n: string }>(sql, params)).rows[0].n);
};

/** El id de la fila de `members` de esa persona en esa organización. */
async function memberIdOf(user: TestUser, tenant = w.tenantA): Promise<string> {
  await actAsPostgres(setup);
  const { rows } = await setup.query<{ id: string }>(
    "select id from public.members where tenant_id = $1 and user_id = $2",
    [tenant, user.id],
  );
  return rows[0].id;
}

const memberRow = async (id: string) => {
  await actAsPostgres(setup);
  return (await setup.query("select * from public.members where id = $1", [id])).rows[0];
};

/** Suma una persona nueva (con nombre) a la organización con el rol dado, como lo haría una aceptación. */
async function addMember(role: string, tenant = w.tenantA, fullName = `Persona ${role}`) {
  const user = await createUser(setup, { meta: { full_name: fullName } });
  await actAsPostgres(setup);
  const { rows } = await setup.query<{ id: string }>(
    "insert into public.members (tenant_id, user_id, role) values ($1, $2, $3) returning id",
    [tenant, user.id, role],
  );
  return { user, memberId: rows[0].id };
}

const auditRows = async (action: string, resourceId?: string) => {
  await actAsPostgres(setup);
  return (
    await setup.query(
      `select * from public.audit_log where tenant_id = $1 and action = $2
         and ($3::uuid is null or resource_id = $3) order by occurred_at, id`,
      [w.tenantA, action, resourceId ?? null],
    )
  ).rows;
};

type Prepared = { id: string; email: string; tokenSha: string; params: unknown[] };
function prepareInvitation(email: string, role = "sales"): Prepared {
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

/** Invita con la función real (como `inviter`) a un correo cualquiera. */
async function inviteAs(inviter: TestUser, role = "viewer", tenant = w.tenantA) {
  const p = prepareInvitation(`invitada-${randomUUID().slice(0, 8)}@ejemplo.test`, role);
  const result = await call(inviter, tenant, CREATE_INVITATION, p.params);
  expect(result.result).toBe("created");
  return p;
}

/**
 * Una invitación a un rol que maneja el equipo a nombre de `inviter` (que no es el Dueño), con el aviso al Dueño
 * anotado: como las que H-008 dejaba crear antes de H-010. Desde H-010 eso da `owner_only`, así que la crea el Dueño y
 * se reescribe, como montaje, quién invitó y el aviso (sin disparadores, solo en esta transacción).
 */
async function legacyInviteAs(inviter: TestUser, role = "admin") {
  const p = await inviteAs(w.owner, role);
  await actAsPostgres(setup);
  await setup.query("set local session_replication_role = replica");
  await setup.query(
    "update public.invitations set invited_by = $2, owner_notice_state = 'pending' where id = $1",
    [p.id, inviter.id],
  );
  await setup.query("update public.email_messages set created_by = $2 where invitation_id = $1", [
    p.id,
    inviter.id,
  ]);
  await setup.query("set local session_replication_role = origin");
  return p;
}

/** Registros de auditoría de cambios en el equipo hechos por `actor` (montaje directo), para llegar al tope. */
async function seedMemberChanges(
  actor: TestUser,
  n: number,
  opts: { tenant?: string; action?: string; ago?: string } = {},
) {
  await actAsPostgres(setup);
  for (let i = 0; i < n; i++) {
    await setup.query(
      `insert into public.audit_log
         (tenant_id, occurred_at, actor_type, actor_user_id, action, resource_type, resource_id, result)
       values ($1, now() - $4::interval, 'user', $2, $3, 'member', $5, 'success')`,
      [
        opts.tenant ?? w.tenantA,
        actor.id,
        opts.action ?? "member.role_changed",
        opts.ago ?? "1 minute",
        randomUUID(),
      ],
    );
  }
}

const invitationStatus = async (id: string) => {
  await actAsPostgres(setup);
  return (
    await setup.query(
      "select status, revoke_reason, revoked_by, owner_notice_state from public.invitations where id = $1",
      [id],
    )
  ).rows[0];
};

describe("list_members", () => {
  it("el Dueño y el Administrador ven a los miembros activos, con nombre, rol, ingreso y correo; el Dueño primero", async () => {
    await withTx(setup, async () => {
      for (const viewer of [w.owner, w.admin]) {
        const list = await call<Json[]>(viewer, w.tenantA, LIST);
        expect(list).toHaveLength(6);
        expect(list[0].role).toBe("owner");
        expect(list[0].user_id).toBe(w.owner.id);
        const ids = list.map((m) => m.user_id);
        expect(ids).toEqual(
          expect.arrayContaining(
            [w.owner, w.admin, w.sales, w.sales2, w.approver, w.viewer].map((u) => u.id),
          ),
        );
        const me = list.filter((m) => m.is_self);
        expect(me).toHaveLength(1);
        expect(me[0].user_id).toBe(viewer.id);
        const sales = list.find((m) => m.user_id === w.sales.id)!;
        expect(sales.email).toBe(w.sales.email);
        expect(sales.role).toBe("sales");
        expect(sales.member_id).toBe(await memberIdOf(w.sales));
        expect(typeof sales.joined_at).toBe("string");
        expect(Object.keys(sales).sort()).toEqual(
          ["email", "full_name", "is_self", "joined_at", "member_id", "role", "user_id"].sort(),
        );
      }
    });
  });

  it("el Aprobador, el Comercial y el Observador reciben «sin permiso»: no ven ni la lista ni los correos", async () => {
    await withTx(setup, async () => {
      for (const user of [w.approver, w.sales, w.viewer]) {
        expect((await denied(user, w.tenantA, LIST)).code).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });
  });

  it("solo entrega a los miembros de ESTA organización", async () => {
    await withTx(setup, async () => {
      const list = await call<Json[]>(w.ownerB, w.tenantB, LIST);
      expect(list).toHaveLength(1);
      expect(list[0].user_id).toBe(w.ownerB.id);
      const inA = await call<Json[]>(w.owner, w.tenantA, LIST);
      expect(inA.map((m) => m.user_id)).not.toContain(w.ownerB.id);
    });
  });

  it("quien no es miembro de la organización pedida (o no pide ninguna) recibe «no encontrado»", async () => {
    await withTx(setup, async () => {
      expect((await denied(w.ownerB, w.tenantA, LIST)).code).toBe(NOT_FOUND);
      await actAsPostgres(setup);
      await asUser(setup, w.owner, w.tenantA);
      await setup.query(`select set_config('request.headers', '{}', true)`);
      const error = await expectSqlError(setup, LIST);
      expect(error.code).toBe(NOT_FOUND);
      await actAsPostgres(setup);
    });
  });

  it("los quitados no salen en la lista", async () => {
    await withTx(setup, async () => {
      const { user, memberId } = await addMember("sales");
      expect((await call<Json[]>(w.owner, w.tenantA, LIST)).map((m) => m.user_id)).toContain(
        user.id,
      );
      await call(w.owner, w.tenantA, REMOVE, [memberId, "sales"]);
      expect((await call<Json[]>(w.owner, w.tenantA, LIST)).map((m) => m.user_id)).not.toContain(
        user.id,
      );
    });
  });

  it("anon no la puede ejecutar; el pase de una persona sí", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<{ anon: boolean; auth: boolean }>(
      `select has_function_privilege('anon', 'public.list_members()', 'EXECUTE') as anon,
              has_function_privilege('authenticated', 'public.list_members()', 'EXECUTE') as auth`,
    );
    expect(rows[0]).toEqual({ anon: false, auth: true });
  });
});

describe("change_member_role · quién puede", () => {
  it("el Dueño cambia el rol de un Comercial: queda en la base y en la auditoría, sin correo", async () => {
    await withTx(setup, async () => {
      const { user, memberId } = await addMember("sales");
      const result = await call(w.owner, w.tenantA, CHANGE, [memberId, "viewer", "sales"]);
      expect(result).toEqual({
        result: "changed",
        member_id: memberId,
        role: "viewer",
        cancelled_invitations: 0,
      });
      expect((await memberRow(memberId)).role).toBe("viewer");
      const audit = await auditRows("member.role_changed", memberId);
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_user_id).toBe(w.owner.id);
      expect(audit[0].result).toBe("success");
      expect(audit[0].resource_type).toBe("member");
      expect(audit[0].details).toEqual({
        old_role: "sales",
        new_role: "viewer",
        cancelled_invitations: 0,
      });
      expect(JSON.stringify(audit[0])).not.toContain(user.email);
      expect(JSON.stringify(audit[0])).not.toContain("@");
    });
  });

  it("el Administrador cambia el rol de quien no maneja el equipo, entre roles que no lo manejan", async () => {
    await withTx(setup, async () => {
      const salesId = await memberIdOf(w.sales);
      expect((await call(w.admin, w.tenantA, CHANGE, [salesId, "approver", "sales"])).result).toBe(
        "changed",
      );
      expect((await call(w.admin, w.tenantA, CHANGE, [salesId, "viewer", "approver"])).result).toBe(
        "changed",
      );
      expect((await memberRow(salesId)).role).toBe("viewer");
    });
  });
});

describe("solo el Dueño da o quita un rol que maneja el equipo", () => {
  it("el Administrador no sube a nadie a Administrador (ni a quien invitó como Observador): «solo el Dueño», sin cambios ni registro", async () => {
    await withTx(setup, async () => {
      // La jugada que se cierra: invitar a alguien como Observador (sin aviso al Dueño) y después subirlo.
      const accomplice = await addMember("viewer", w.tenantA, "Complice");
      const salesId = await memberIdOf(w.sales);
      for (const [target, expected] of [
        [accomplice.memberId, "viewer"],
        [salesId, "sales"],
      ] as const) {
        const error = await denied(w.admin, w.tenantA, CHANGE, [target, "admin", expected]);
        expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
        expect(error.message).toBe("owner_only");
        expect((await memberRow(target)).role).toBe(expected);
      }
      expect(await auditRows("member.role_changed")).toHaveLength(0);
    });
  });

  it("el Administrador no baja ni quita a otro Administrador", async () => {
    await withTx(setup, async () => {
      const other = await addMember("admin", w.tenantA, "Otro Admin");
      const pending = await inviteAs(other.user);
      for (const [sql, params] of [
        [CHANGE, [other.memberId, "sales", "admin"]],
        [CHANGE, [other.memberId, "viewer", "admin"]],
        [REMOVE, [other.memberId, "admin"]],
      ] as const) {
        const error = await denied(w.admin, w.tenantA, sql, [...params]);
        expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
        expect(error.message).toBe("owner_only");
      }
      const row = await memberRow(other.memberId);
      expect(row.role).toBe("admin");
      expect(row.status).toBe("active");
      // Sus invitaciones siguen vivas: no se canceló nada.
      expect((await invitationStatus(pending.id)).status).toBe("pending");
      expect(await auditRows("member.role_changed")).toHaveLength(0);
      expect(await auditRows("member.removed")).toHaveLength(0);
    });
  });

  it("lo que ya está hecho se dice antes que «solo el Dueño»: «ya tenía ese rol» y «ya estaba quitado», sin cambios ni registro", async () => {
    await withTx(setup, async () => {
      // Una pantalla vieja (o una llamada directa): el Administrador «deja» de Administrador a otro Administrador.
      const other = await addMember("admin", w.tenantA, "Admin Igual");
      expect(await call(w.admin, w.tenantA, CHANGE, [other.memberId, "admin", "admin"])).toEqual({
        result: "unchanged",
        member_id: other.memberId,
        role: "admin",
      });
      // El Dueño quitó a un Administrador y otro Administrador, con la lista vieja, intenta quitarlo también.
      const gone = await addMember("admin", w.tenantA, "Admin Que Ya Se Fue");
      expect((await call(w.owner, w.tenantA, REMOVE, [gone.memberId, "admin"])).result).toBe(
        "removed",
      );
      expect(await call(w.admin, w.tenantA, REMOVE, [gone.memberId, "admin"])).toEqual({
        result: "already_removed",
        member_id: gone.memberId,
      });
      expect((await memberRow(other.memberId)).role).toBe("admin");
      expect(await auditRows("member.role_changed")).toHaveLength(0);
      expect(await auditRows("member.removed", gone.memberId)).toHaveLength(1);
      // Con un cambio de verdad sigue siendo «solo el Dueño».
      const error = await denied(w.admin, w.tenantA, CHANGE, [other.memberId, "sales", "admin"]);
      expect(error.message).toBe("owner_only");
    });
  });

  it("el Dueño sí sube a Administrador, baja a un Administrador y lo quita", async () => {
    await withTx(setup, async () => {
      const person = await addMember("viewer", w.tenantA, "Sube Y Baja");
      expect(
        await call(w.owner, w.tenantA, CHANGE, [person.memberId, "admin", "viewer"]),
      ).toMatchObject({ result: "changed", role: "admin" });
      expect(
        await call(w.owner, w.tenantA, CHANGE, [person.memberId, "sales", "admin"]),
      ).toMatchObject({ result: "changed", role: "sales" });
      const other = await addMember("admin", w.tenantA, "Admin Que Sale");
      expect((await call(w.owner, w.tenantA, REMOVE, [other.memberId, "admin"])).result).toBe(
        "removed",
      );
      expect((await memberRow(other.memberId)).status).toBe("removed");
      expect(await auditRows("member.role_changed", person.memberId)).toHaveLength(2);
      expect(await auditRows("member.removed", other.memberId)).toHaveLength(1);
    });
  });
});

describe("tope de cambios en el equipo por hora (cambios de rol y quitadas, sumados)", () => {
  it(`cada persona hace hasta ${MEMBER_CHANGES_PER_HOUR} cambios por hora en una organización; el siguiente cambio de rol, y también quitar, recibe «tope» y no cambia nada`, async () => {
    await withTx(setup, async () => {
      const { memberId } = await addMember("sales", w.tenantA, "Sube Y Baja Mucho");
      const flip = (role: string) => (role === "sales" ? "viewer" : "sales");
      let role = "sales";
      for (let i = 0; i < MEMBER_CHANGES_PER_HOUR; i++) {
        expect((await call(w.admin, w.tenantA, CHANGE, [memberId, flip(role), role])).result).toBe(
          "changed",
        );
        role = flip(role);
      }
      // «Ya tenía ese rol» no deja registro y no choca con el tope.
      expect((await call(w.admin, w.tenantA, CHANGE, [memberId, role, role])).result).toBe(
        "unchanged",
      );
      const error = await denied(w.admin, w.tenantA, CHANGE, [memberId, flip(role), role]);
      expect(error.code).toBe(TOO_MANY);
      expect(error.message).toBe("limit_member_changes");
      expect((await memberRow(memberId)).role).toBe(role);
      expect(await auditRows("member.role_changed", memberId)).toHaveLength(
        MEMBER_CHANGES_PER_HOUR,
      );
      // Quitar suma al mismo tope: tampoco puede quitar.
      const removal = await denied(w.admin, w.tenantA, REMOVE, [memberId, role]);
      expect(removal.code).toBe(TOO_MANY);
      expect(removal.message).toBe("limit_member_changes");
      expect((await memberRow(memberId)).status).toBe("active");
      // El tope es de cada persona: el Dueño sigue pudiendo.
      expect((await call(w.owner, w.tenantA, CHANGE, [memberId, flip(role), role])).result).toBe(
        "changed",
      );
      expect((await call(w.owner, w.tenantA, REMOVE, [memberId, flip(role)])).result).toBe(
        "removed",
      );
    });
  });

  it("el Dueño no tiene tope: con más de 30 cambios en la hora sigue cambiando roles y quitando; un Administrador con los mismos, no", async () => {
    await withTx(setup, async () => {
      // El Dueño y el Administrador ya hicieron, cada uno, más del tope en la última hora (montaje directo).
      await seedMemberChanges(w.owner, MEMBER_CHANGES_PER_HOUR + 5);
      await seedMemberChanges(w.admin, MEMBER_CHANGES_PER_HOUR + 5);
      const one = await addMember("sales", w.tenantA, "Comercial Incidente Uno");
      const two = await addMember("approver", w.tenantA, "Aprobador Incidente Dos");
      // El Dueño limpia el equipo en un incidente: cambia y quita sin tope (cada acción deja su registro).
      expect(
        (await call(w.owner, w.tenantA, CHANGE, [one.memberId, "viewer", "sales"])).result,
      ).toBe("changed");
      expect((await call(w.owner, w.tenantA, REMOVE, [one.memberId, "viewer"])).result).toBe(
        "removed",
      );
      expect(await auditRows("member.role_changed", one.memberId)).toHaveLength(1);
      expect(await auditRows("member.removed", one.memberId)).toHaveLength(1);
      // El Administrador sigue con tope, para cambiar y para quitar.
      for (const [sql, params] of [
        [CHANGE, [two.memberId, "viewer", "approver"]],
        [REMOVE, [two.memberId, "approver"]],
      ] as const) {
        const error = await denied(w.admin, w.tenantA, sql, [...params]);
        expect(error.code).toBe(TOO_MANY);
        expect(error.message).toBe("limit_member_changes");
      }
      expect(await memberRow(two.memberId)).toMatchObject({ status: "active", role: "approver" });
    });
  });

  it("quitar cuenta para el tope: un Administrador no vacía el equipo de una vez", async () => {
    await withTx(setup, async () => {
      // Ya quitó a 29 personas en la última hora (montaje directo).
      await seedMemberChanges(w.admin, MEMBER_CHANGES_PER_HOUR - 1, { action: "member.removed" });
      const one = await addMember("sales", w.tenantA, "Comercial Uno");
      const two = await addMember("approver", w.tenantA, "Aprobador Dos");
      const three = await addMember("viewer", w.tenantA, "Observador Tres");
      // La número 30 pasa; la 31 no, ni tampoco un cambio de rol.
      expect((await call(w.admin, w.tenantA, REMOVE, [one.memberId, "sales"])).result).toBe(
        "removed",
      );
      const error = await denied(w.admin, w.tenantA, REMOVE, [two.memberId, "approver"]);
      expect(error.code).toBe(TOO_MANY);
      expect(error.message).toBe("limit_member_changes");
      expect(
        (await denied(w.admin, w.tenantA, CHANGE, [three.memberId, "sales", "viewer"])).message,
      ).toBe("limit_member_changes");
      expect((await memberRow(two.memberId)).status).toBe("active");
      expect((await memberRow(three.memberId)).role).toBe("viewer");
      expect(await auditRows("member.removed", two.memberId)).toHaveLength(0);
      // «Ya estaba quitado» no deja registro y no choca con el tope.
      expect((await call(w.admin, w.tenantA, REMOVE, [one.memberId, "sales"])).result).toBe(
        "already_removed",
      );
    });
  });

  it("cambios de rol y quitadas se suman: 15 y 15 llegan al tope", async () => {
    await withTx(setup, async () => {
      const half = MEMBER_CHANGES_PER_HOUR / 2;
      await seedMemberChanges(w.admin, half, { action: "member.removed" });
      await seedMemberChanges(w.admin, half, { action: "member.role_changed" });
      const person = await addMember("sales", w.tenantA, "Comercial Tope Mixto");
      expect(
        (await denied(w.admin, w.tenantA, CHANGE, [person.memberId, "viewer", "sales"])).code,
      ).toBe(TOO_MANY);
      expect((await denied(w.admin, w.tenantA, REMOVE, [person.memberId, "sales"])).code).toBe(
        TOO_MANY,
      );
    });
  });

  it("el tope es por organización: quien llegó al tope en A sigue pudiendo en B, y A sigue con su tope", async () => {
    await withTx(setup, async () => {
      // Una Administradora de A y de B, con 30 cambios en A en la última hora.
      const mixed = await addMember("admin", w.tenantA, "Mixta Con Tope");
      await actAsPostgres(setup);
      await setup.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'admin')",
        [w.tenantB, mixed.user.id],
      );
      await seedMemberChanges(mixed.user, MEMBER_CHANGES_PER_HOUR, { tenant: w.tenantA });
      const inA = await addMember("sales", w.tenantA, "Comercial de A");
      const inB = await addMember("sales", w.tenantB, "Comercial de B");
      // En A, tope.
      expect(
        (await denied(mixed.user, w.tenantA, CHANGE, [inA.memberId, "viewer", "sales"])).code,
      ).toBe(TOO_MANY);
      // En B no cuenta lo que hizo en A: cambia y quita.
      expect(
        (await call(mixed.user, w.tenantB, CHANGE, [inB.memberId, "viewer", "sales"])).result,
      ).toBe("changed");
      expect((await call(mixed.user, w.tenantB, REMOVE, [inB.memberId, "viewer"])).result).toBe(
        "removed",
      );
      // Lo que hizo en B tampoco libera nada en A.
      expect((await denied(mixed.user, w.tenantA, REMOVE, [inA.memberId, "sales"])).code).toBe(
        TOO_MANY,
      );
      expect((await memberRow(inA.memberId)).status).toBe("active");
    });
  });

  it("los cambios de hace más de una hora no cuentan", async () => {
    await withTx(setup, async () => {
      const { memberId } = await addMember("sales", w.tenantA, "Cambios Viejos");
      // Registros viejos de esta persona (montaje directo): no cuentan para el tope.
      await actAsPostgres(setup);
      for (let i = 0; i < MEMBER_CHANGES_PER_HOUR; i++) {
        await setup.query(
          `insert into public.audit_log
             (tenant_id, occurred_at, actor_type, actor_user_id, action, resource_type, resource_id, result)
           values ($1, now() - interval '61 minutes', 'user', $2, 'member.role_changed', 'member', $3, 'success')`,
          [w.tenantA, w.admin.id, memberId],
        );
      }
      expect((await call(w.admin, w.tenantA, CHANGE, [memberId, "viewer", "sales"])).result).toBe(
        "changed",
      );
    });
  });
});

describe("change_member_role · sin permiso", () => {
  it("el Aprobador, el Comercial y el Observador reciben «sin permiso» y no cambia nada", async () => {
    await withTx(setup, async () => {
      const salesId = await memberIdOf(w.sales);
      for (const user of [w.approver, w.sales, w.viewer]) {
        const error = await denied(user, w.tenantA, CHANGE, [salesId, "admin", "sales"]);
        expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
      }
      expect((await memberRow(salesId)).role).toBe("sales");
      expect(await auditRows("member.role_changed")).toHaveLength(0);
    });
  });

  it("quien no es miembro de la organización recibe «no encontrado», no «sin permiso»", async () => {
    await withTx(setup, async () => {
      const salesId = await memberIdOf(w.sales);
      const error = await denied(w.ownerB, w.tenantA, CHANGE, [salesId, "viewer", "sales"]);
      expect(error.code).toBe(NOT_FOUND);
      expect((await memberRow(salesId)).role).toBe("sales");
    });
  });
});

describe("change_member_role · otra organización", () => {
  it("un miembro de B, apuntado desde A (o desde B por el Dueño de A), es «miembro no encontrado» y queda intacto", async () => {
    await withTx(setup, async () => {
      const inB = await addMember("sales", w.tenantB, "Comercial de B");
      // El Dueño de A, parado en A, con el id de un miembro de B.
      const fromA = await denied(w.owner, w.tenantA, CHANGE, [inB.memberId, "viewer", "sales"]);
      expect(fromA.code).toBe(NOT_FOUND);
      expect(fromA.message).toBe("member_not_found");
      const removeFromA = await denied(w.owner, w.tenantA, REMOVE, [inB.memberId, "sales"]);
      expect(removeFromA.code).toBe(NOT_FOUND);
      // El Dueño de A no es miembro de B: con la cabecera de B no entra.
      expect(
        (await denied(w.owner, w.tenantB, CHANGE, [inB.memberId, "viewer", "sales"])).code,
      ).toBe(NOT_FOUND);
      expect((await denied(w.owner, w.tenantB, REMOVE, [inB.memberId, "sales"])).code).toBe(
        NOT_FOUND,
      );
      const row = await memberRow(inB.memberId);
      expect(row.role).toBe("sales");
      expect(row.status).toBe("active");
    });
  });

  it("una persona que está en A y en B, parada en A, no puede tocar a un miembro de B", async () => {
    await withTx(setup, async () => {
      const mixed = await addMember("admin", w.tenantA, "Mixta");
      await actAsPostgres(setup);
      await setup.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'admin')",
        [w.tenantB, mixed.user.id],
      );
      const inB = await addMember("viewer", w.tenantB, "Observador de B");
      expect(
        (await denied(mixed.user, w.tenantA, CHANGE, [inB.memberId, "sales", "viewer"])).code,
      ).toBe(NOT_FOUND);
      expect((await denied(mixed.user, w.tenantA, REMOVE, [inB.memberId, "viewer"])).code).toBe(
        NOT_FOUND,
      );
      expect((await memberRow(inB.memberId)).role).toBe("viewer");
      // Y en B sí puede (control): es Administradora de B.
      expect(
        (await call(mixed.user, w.tenantB, CHANGE, [inB.memberId, "sales", "viewer"])).result,
      ).toBe("changed");
    });
  });

  it("un id que no existe da lo mismo que uno de otra organización", async () => {
    await withTx(setup, async () => {
      const error = await denied(w.owner, w.tenantA, CHANGE, [randomUUID(), "viewer", "sales"]);
      expect(error.code).toBe(NOT_FOUND);
      expect(error.message).toBe("member_not_found");
    });
  });
});

describe("el Dueño y uno mismo", () => {
  it("nadie cambia ni quita al Dueño, ni siquiera él mismo ni un Administrador", async () => {
    await withTx(setup, async () => {
      const ownerId = await memberIdOf(w.owner);
      for (const actor of [w.admin]) {
        for (const [sql, params] of [
          [CHANGE, [ownerId, "viewer", "owner"]],
          [CHANGE, [ownerId, "admin", "owner"]],
          [REMOVE, [ownerId, "owner"]],
        ] as const) {
          const error = await denied(actor, w.tenantA, sql, [...params]);
          expect(error.code).toBe(NOT_ALLOWED);
          expect(error.message).toBe("cannot_target_owner");
        }
      }
      const row = await memberRow(ownerId);
      expect(row.role).toBe("owner");
      expect(row.status).toBe("active");
    });
  });

  it("nadie sube a otra persona a Dueño: el rol «owner» no es un rol que se pueda dar", async () => {
    await withTx(setup, async () => {
      const salesId = await memberIdOf(w.sales);
      for (const actor of [w.owner, w.admin]) {
        const error = await denied(actor, w.tenantA, CHANGE, [salesId, "owner", "sales"]);
        expect(error.code).toBe(INVALID);
        expect(error.message).toBe("invalid_role");
      }
      for (const bad of ["superjefe", "", "ADMIN", "admin ", "admin'; --"]) {
        const error = await denied(w.owner, w.tenantA, CHANGE, [salesId, bad, "sales"]);
        expect(error.code).toBe(INVALID);
        expect(error.message).toBe("invalid_role");
      }
      expect((await memberRow(salesId)).role).toBe("sales");
      // Sigue habiendo un solo Dueño activo.
      expect(
        await count(
          "select count(*) as n from public.members where tenant_id = $1 and status = 'active' and role = 'owner'",
          [w.tenantA],
        ),
      ).toBe(1);
    });
  });

  it("nadie se cambia el rol ni se quita a sí mismo (así un Administrador no puede ascenderse)", async () => {
    await withTx(setup, async () => {
      const adminId = await memberIdOf(w.admin);
      for (const [sql, params] of [
        [CHANGE, [adminId, "viewer", "admin"]],
        [CHANGE, [adminId, "admin", "admin"]],
        [REMOVE, [adminId, "admin"]],
      ] as const) {
        const error = await denied(w.admin, w.tenantA, sql, [...params]);
        expect(error.code).toBe(NOT_ALLOWED);
        expect(error.message).toBe("cannot_target_self");
      }
      const ownerId = await memberIdOf(w.owner);
      expect((await denied(w.owner, w.tenantA, REMOVE, [ownerId, "owner"])).message).toBe(
        "cannot_target_self",
      );
      expect((await memberRow(adminId)).role).toBe("admin");
      expect((await memberRow(adminId)).status).toBe("active");
    });
  });

  it("faltan argumentos: dato inválido, sin tocar nada", async () => {
    await withTx(setup, async () => {
      const salesId = await memberIdOf(w.sales);
      for (const params of [
        [null, "viewer", "sales"],
        [salesId, null, "sales"],
        [salesId, "viewer", null],
      ]) {
        const error = await denied(w.owner, w.tenantA, CHANGE, params);
        expect(error.code).toBe(INVALID);
        expect(error.message).toBe("invalid_arguments");
      }
      expect((await denied(w.owner, w.tenantA, REMOVE, [null, "sales"])).code).toBe(INVALID);
      expect((await denied(w.owner, w.tenantA, REMOVE, [salesId, null])).code).toBe(INVALID);
    });
  });
});

describe("rol esperado desactualizado y repetir", () => {
  it("si el rol real ya no es el que la persona vio, no se cambia nada («el rol cambió»)", async () => {
    await withTx(setup, async () => {
      const { memberId } = await addMember("sales");
      await call(w.owner, w.tenantA, CHANGE, [memberId, "viewer", "sales"]);
      // La otra pestaña todavía cree que es Comercial.
      const staleChange = await denied(w.admin, w.tenantA, CHANGE, [memberId, "approver", "sales"]);
      expect(staleChange.code).toBe(CONFLICT);
      expect(staleChange.message).toBe("role_changed");
      const staleRemove = await denied(w.admin, w.tenantA, REMOVE, [memberId, "sales"]);
      expect(staleRemove.code).toBe(CONFLICT);
      const row = await memberRow(memberId);
      expect(row.role).toBe("viewer");
      expect(row.status).toBe("active");
      // Con el rol correcto sí funciona.
      expect(
        (await call(w.admin, w.tenantA, CHANGE, [memberId, "approver", "viewer"])).result,
      ).toBe("changed");
    });
  });

  it("cambiar a un rol que ya tiene es «listo»: sin cambios ni registro (aunque el rol esperado sea otro)", async () => {
    await withTx(setup, async () => {
      const { memberId } = await addMember("sales");
      for (const expected of ["sales", "viewer"]) {
        const result = await call(w.owner, w.tenantA, CHANGE, [memberId, "sales", expected]);
        expect(result).toEqual({ result: "unchanged", member_id: memberId, role: "sales" });
      }
      expect(await auditRows("member.role_changed", memberId)).toHaveLength(0);
    });
  });

  it("quitar a alguien ya quitado es «listo» y no deja otro registro", async () => {
    await withTx(setup, async () => {
      const { memberId } = await addMember("sales");
      expect((await call(w.owner, w.tenantA, REMOVE, [memberId, "sales"])).result).toBe("removed");
      const again = await call(w.admin, w.tenantA, REMOVE, [memberId, "sales"]);
      expect(again).toEqual({ result: "already_removed", member_id: memberId });
      expect(await auditRows("member.removed", memberId)).toHaveLength(1);
    });
  });

  it("cambiar el rol de alguien ya quitado: no encontrado", async () => {
    await withTx(setup, async () => {
      const { memberId } = await addMember("sales");
      await call(w.owner, w.tenantA, REMOVE, [memberId, "sales"]);
      const error = await denied(w.owner, w.tenantA, CHANGE, [memberId, "viewer", "sales"]);
      expect(error.code).toBe(NOT_FOUND);
      expect((await memberRow(memberId)).role).toBe("sales");
    });
  });
});

describe("remove_member", () => {
  it("el Dueño y el Administrador quitan a un miembro: queda «quitado» con cuándo y quién, y la fila no se borra", async () => {
    await withTx(setup, async () => {
      for (const actor of [w.owner, w.admin]) {
        const { user, memberId } = await addMember("sales");
        const result = await call(actor, w.tenantA, REMOVE, [memberId, "sales"]);
        expect(result).toEqual({
          result: "removed",
          member_id: memberId,
          cancelled_invitations: 0,
          assigned_requests: 0,
        });
        const row = await memberRow(memberId);
        expect(row.status).toBe("removed");
        expect(row.removed_by).toBe(actor.id);
        expect(row.removed_at).not.toBeNull();
        expect(row.user_id).toBe(user.id);
        expect(row.role).toBe("sales");
        const audit = await auditRows("member.removed", memberId);
        expect(audit).toHaveLength(1);
        expect(audit[0].actor_user_id).toBe(actor.id);
        expect(audit[0].details).toEqual({ role: "sales", cancelled_invitations: 0 });
        expect(JSON.stringify(audit[0])).not.toContain("@");
      }
    });
  });

  it("el Aprobador, el Comercial y el Observador reciben «sin permiso» y nadie sale", async () => {
    await withTx(setup, async () => {
      const salesId = await memberIdOf(w.sales2);
      for (const user of [w.approver, w.sales, w.viewer]) {
        expect((await denied(user, w.tenantA, REMOVE, [salesId, "sales"])).code).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
      expect((await memberRow(salesId)).status).toBe("active");
      expect(await auditRows("member.removed")).toHaveLength(0);
    });
  });

  it("no se borra nada de lo que hizo: su cotización sigue y su nombre se sigue leyendo; los demás no pierden nada", async () => {
    await withTx(setup, async () => {
      const { user, memberId } = await addMember("sales", w.tenantA, "Vendedora Que Se Fue");
      const quoteId = await createQuote(setup, user, w.tenantA, w.customerA);
      await call(w.owner, w.tenantA, REMOVE, [memberId, "sales"]);

      await actAsPostgres(setup);
      const quote = (
        await setup.query("select created_by from public.quotes where id = $1", [quoteId])
      ).rows[0];
      expect(quote.created_by).toBe(user.id);

      // Quienes siguen en la organización ven la cotización Y el nombre de su autora.
      for (const reader of [w.owner, w.viewer, w.approver]) {
        await asUser(setup, reader, w.tenantA);
        const quotes = await setup.query("select id from public.quotes where id = $1", [quoteId]);
        expect(quotes.rowCount).toBe(1);
        const profile = await setup.query<{ full_name: string }>(
          "select full_name from public.profiles where user_id = $1",
          [user.id],
        );
        expect(profile.rows).toEqual([{ full_name: "Vendedora Que Se Fue" }]);
        await actAsPostgres(setup);
      }
      // Solo el nombre: el correo no está en `profiles` y no se puede leer ninguna otra columna.
      await asUser(setup, w.owner, w.tenantA);
      const columns = await expectSqlError(
        setup,
        "select last_tenant_id from public.profiles where user_id = $1",
        [user.id],
      );
      expect(columns.code).toBe(INSUFFICIENT_PRIVILEGE);
      await actAsPostgres(setup);
    });
  });

  it("el nombre de un ex miembro lo lee solo su organización, no otra", async () => {
    await withTx(setup, async () => {
      const { user, memberId } = await addMember("sales", w.tenantA, "Nombre Reservado A");
      await call(w.owner, w.tenantA, REMOVE, [memberId, "sales"]);
      // El Dueño de B, parado en B, no lo ve.
      await asUser(setup, w.ownerB, w.tenantB);
      const rows = await setup.query("select full_name from public.profiles where user_id = $1", [
        user.id,
      ]);
      expect(rows.rowCount).toBe(0);
      await actAsPostgres(setup);
    });
  });

  it("alguien quitado, con su pase todavía vigente, ya no ve ni toca nada de la organización", async () => {
    await withTx(setup, async () => {
      const { user, memberId } = await addMember("admin", w.tenantA, "Admin Quitado");
      // Control: antes de quitarlo ve y puede.
      await asUser(setup, user, w.tenantA);
      expect((await setup.query("select id from public.customers")).rowCount).toBeGreaterThan(0);
      expect((await setup.query<{ r: Json[] }>(LIST)).rows[0].r.length).toBeGreaterThan(1);
      await actAsPostgres(setup);

      await call(w.owner, w.tenantA, REMOVE, [memberId, "admin"]);

      await asUser(setup, user, w.tenantA);
      for (const table of ["customers", "catalog_items", "quotes", "invitations", "audit_log"]) {
        expect((await setup.query(`select 1 from public.${table}`)).rowCount, table).toBe(0);
      }
      // De `members` solo ve sus propias filas (la de esta organización, ya «quitado»).
      const members = await setup.query<{ user_id: string }>("select user_id from public.members");
      expect(members.rows.every((r) => r.user_id === user.id)).toBe(true);
      // Del resto de los perfiles, solo el suyo.
      const profiles = await setup.query<{ user_id: string }>(
        "select user_id from public.profiles",
      );
      expect(profiles.rows.map((r) => r.user_id)).toEqual([user.id]);
      const tenants = await setup.query("select 1 from public.tenants where tenant_id = $1", [
        w.tenantA,
      ]);
      expect(tenants.rowCount).toBe(0);
      await actAsPostgres(setup);

      // Y todas las funciones de equipo y de cotizar le responden «no encontrado» / «prohibido».
      const salesId = await memberIdOf(w.sales);
      expect((await denied(user, w.tenantA, LIST)).code).toBe(NOT_FOUND);
      expect((await denied(user, w.tenantA, CHANGE, [salesId, "viewer", "sales"])).code).toBe(
        NOT_FOUND,
      );
      expect((await denied(user, w.tenantA, REMOVE, [salesId, "sales"])).code).toBe(NOT_FOUND);
      const quote = await denied(user, w.tenantA, "select public.create_quote($1, $2)", [
        w.customerA,
        randomUUID(),
      ]);
      expect([INSUFFICIENT_PRIVILEGE, NOT_FOUND]).toContain(quote.code);
      expect((await memberRow(salesId)).role).toBe("sales");
    });
  });

  it("sus borradores siguen existiendo pero nadie más los edita (solo el autor, decisión 009)", async () => {
    await withTx(setup, async () => {
      const { user, memberId } = await addMember("sales");
      const quoteId = await createQuote(setup, user, w.tenantA, w.customerA, false);
      await call(w.owner, w.tenantA, REMOVE, [memberId, "sales"]);
      // El autor ya no puede.
      const byAuthor = await denied(user, w.tenantA, "select public.revoke_quote_links($1)", [
        quoteId,
      ]);
      expect([INSUFFICIENT_PRIVILEGE, NOT_FOUND]).toContain(byAuthor.code);
      // El Dueño lo ve, pero no es el autor: no puede editarlo.
      await asUser(setup, w.owner, w.tenantA);
      expect(
        (await setup.query("select 1 from public.quotes where id = $1", [quoteId])).rowCount,
      ).toBe(1);
      const rowOf = async () => {
        await actAsPostgres(setup);
        return (
          await setup.query("select to_jsonb(q) as r from public.quotes q where id = $1", [quoteId])
        ).rows[0].r;
      };
      const before = await rowOf();
      await asUser(setup, w.owner, w.tenantA);
      const save = await expectSqlError(
        setup,
        "select public.save_quote_draft($1, 1, $2, $3, $4, $5)",
        [quoteId, randomUUID(), "{}", "[]", "{}"],
      );
      // Rechazado por no ser el autor (permiso), no por una forma inválida, y el borrador no cambió.
      expect(save.code).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await rowOf()).toEqual(before);
      await actAsPostgres(setup);
    });
  });

  it("sus solicitudes asignadas siguen asignadas a él (el Dueño y los Administradores las pueden reasignar)", async () => {
    await withTx(setup, async () => {
      const { user, memberId } = await addMember("sales");
      const form = await makeForm(setup, w.owner, w.tenantA, { publish: false });
      await actAsPostgres(setup);
      const requestId = await insertRequest(setup, w.tenantA, form.formId);
      await setup.query(
        `update public.intake_requests
            set status = 'assigned', assigned_to = $2, assigned_at = now(), assigned_by = $3
          where id = $1`,
        [requestId, user.id, w.owner.id],
      );
      // El resultado dice cuántas quedaron esperando que alguien las reasigne.
      const removed = await call(w.owner, w.tenantA, REMOVE, [memberId, "sales"]);
      expect(removed.assigned_requests).toBe(1);
      await actAsPostgres(setup);
      const request = (
        await setup.query("select status, assigned_to from public.intake_requests where id = $1", [
          requestId,
        ])
      ).rows[0];
      expect(request).toEqual({ status: "assigned", assigned_to: user.id });
      // El Dueño puede reasignarla a alguien que sigue en el equipo.
      const reassigned = await call(
        w.owner,
        w.tenantA,
        "select public.assign_intake_request($1, $2) as r",
        [requestId, w.sales2.id],
      );
      expect(reassigned.assigned_to).toBe(w.sales2.id);
    });
  });
});

describe("invitaciones de quien sale o baja de rol", () => {
  it("al quitar a un Administrador se cancelan las invitaciones PENDIENTES que envió, con su motivo; las demás no se tocan", async () => {
    await withTx(setup, async () => {
      const inviter = await addMember("admin", w.tenantA, "Admin Invitador");
      const mine1 = await inviteAs(inviter.user);
      const mine2 = await inviteAs(inviter.user, "approver");
      // Una vencida pero todavía «pendiente» también se cancela.
      await actAsPostgres(setup);
      await setup.query(
        "update public.invitations set expires_at = now() - interval '1 day' where id = $1",
        [mine2.id],
      );
      // Otra que ya cancelaron a mano (se conserva su motivo) y una que envió otra persona (no se toca).
      const alreadyRevoked = await inviteAs(inviter.user);
      await call(inviter.user, w.tenantA, "select public.revoke_invitation($1) as r", [
        alreadyRevoked.id,
      ]);
      const ownersInvite = await inviteAs(w.owner);
      const result = await call(w.owner, w.tenantA, REMOVE, [inviter.memberId, "admin"]);
      expect(result.cancelled_invitations).toBe(2);

      for (const p of [mine1, mine2]) {
        const row = await invitationStatus(p.id);
        expect(row.status).toBe("revoked");
        expect(row.revoke_reason).toBe("inviter_removed");
        expect(row.revoked_by).toBe(w.owner.id);
      }
      expect((await invitationStatus(alreadyRevoked.id)).revoke_reason).toBe("cancelled");
      expect((await invitationStatus(ownersInvite.id)).status).toBe("pending");
      const audit = await auditRows("member.removed", inviter.memberId);
      expect(audit[0].details).toEqual({ role: "admin", cancelled_invitations: 2 });
    });
  });

  it("una invitación ya aceptada no se cancela", async () => {
    await withTx(setup, async () => {
      const inviter = await addMember("admin");
      const guest = await createUser(setup);
      const p = prepareInvitation(guest.email, "viewer");
      expect((await call(inviter.user, w.tenantA, CREATE_INVITATION, p.params)).result).toBe(
        "created",
      );
      const accepted = await call(guest, w.tenantA, ACCEPT, [p.tokenSha]);
      expect(accepted.result).toBe("accepted");
      const removed = await call(w.owner, w.tenantA, REMOVE, [inviter.memberId, "admin"]);
      expect(removed.cancelled_invitations).toBe(0);
      expect((await invitationStatus(p.id)).status).toBe("accepted");
    });
  });

  it("el aviso al Dueño por una invitación cancelada sale de la cola", async () => {
    await withTx(setup, async () => {
      const inviter = await addMember("admin");
      // Un Administrador invitó a otro Administrador antes de H-010: quedó un aviso pendiente para el Dueño.
      const p = await legacyInviteAs(inviter.user);
      expect((await invitationStatus(p.id)).owner_notice_state).toBe("pending");
      await call(w.owner, w.tenantA, REMOVE, [inviter.memberId, "admin"]);
      const row = await invitationStatus(p.id);
      expect(row.status).toBe("revoked");
      expect(row.owner_notice_state).toBe("none");
    });
  });

  it("quien intenta usar el enlace de una invitación cancelada así recibe «quien te invitó ya no puede invitar»", async () => {
    await withTx(setup, async () => {
      const inviter = await addMember("admin");
      const guest = await createUser(setup);
      const p = prepareInvitation(guest.email, "sales");
      await call(inviter.user, w.tenantA, CREATE_INVITATION, p.params);
      await call(w.owner, w.tenantA, REMOVE, [inviter.memberId, "admin"]);
      const attempt = await call(guest, w.tenantA, ACCEPT, [p.tokenSha]);
      expect(attempt.result).toBe("inviter_inactive");
      expect(
        await count(
          "select count(*) as n from public.members where tenant_id = $1 and user_id = $2",
          [w.tenantA, guest.id],
        ),
      ).toBe(0);
    });
  });

  it("al bajar a un Administrador a un rol que no maneja el equipo también se cancelan sus invitaciones", async () => {
    await withTx(setup, async () => {
      const inviter = await addMember("admin");
      const p1 = await inviteAs(inviter.user);
      // Una a Administrador hecha antes de H-010 (desde H-010 solo el Dueño invita Administradores).
      const p2 = await legacyInviteAs(inviter.user);
      const result = await call(w.owner, w.tenantA, CHANGE, [inviter.memberId, "sales", "admin"]);
      expect(result).toMatchObject({ result: "changed", role: "sales", cancelled_invitations: 2 });
      for (const p of [p1, p2]) {
        const row = await invitationStatus(p.id);
        expect(row.status).toBe("revoked");
        expect(row.revoke_reason).toBe("inviter_removed");
      }
      const audit = await auditRows("member.role_changed", inviter.memberId);
      expect(audit[0].details).toEqual({
        old_role: "admin",
        new_role: "sales",
        cancelled_invitations: 2,
      });
    });
  });

  it("subir a alguien a Administrador, o cambiar entre roles que no manejan el equipo, no cancela nada", async () => {
    await withTx(setup, async () => {
      const person = await addMember("sales");
      // Una invitación suelta a nombre de esta persona (montaje directo: hoy un Comercial no puede invitar).
      await actAsPostgres(setup);
      const pending = prepareInvitation("suelta@ejemplo.test", "viewer");
      await setup.query(
        `insert into public.invitations
           (id, tenant_id, email_enc, email_hash, email_binding, role, token_sha256, status, expires_at, invited_by)
         values ($1, $2, 'v1.x.y', $3, $4, 'viewer', $5, 'pending', now() + interval '3 days', $6)`,
        [pending.id, w.tenantA, sha256Hex("h"), sha256Hex("b"), pending.tokenSha, person.user.id],
      );
      expect(
        (await call(w.owner, w.tenantA, CHANGE, [person.memberId, "viewer", "sales"]))
          .cancelled_invitations,
      ).toBe(0);
      expect(
        (await call(w.owner, w.tenantA, CHANGE, [person.memberId, "admin", "viewer"]))
          .cancelled_invitations,
      ).toBe(0);
      expect((await invitationStatus(pending.id)).status).toBe("pending");
    });
  });

  it("las invitaciones de otra organización con la misma persona como invitadora no se tocan", async () => {
    await withTx(setup, async () => {
      const inviter = await addMember("admin", w.tenantA, "Admin En Dos");
      await actAsPostgres(setup);
      await setup.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'admin')",
        [w.tenantB, inviter.user.id],
      );
      const inB = await inviteAs(inviter.user, "viewer", w.tenantB);
      const inA = await inviteAs(inviter.user, "viewer", w.tenantA);
      await call(w.owner, w.tenantA, REMOVE, [inviter.memberId, "admin"]);
      expect((await invitationStatus(inA.id)).status).toBe("revoked");
      expect((await invitationStatus(inB.id)).status).toBe("pending");
    });
  });
});

describe("reactivar a un quitado por invitación (H-009)", () => {
  it("se invita de nuevo, acepta y vuelve a ser miembro activo con el rol de la invitación", async () => {
    await withTx(setup, async () => {
      const { user, memberId } = await addMember("sales");
      await call(w.owner, w.tenantA, REMOVE, [memberId, "sales"]);
      expect((await memberRow(memberId)).status).toBe("removed");
      const p = prepareInvitation(user.email, "viewer");
      expect((await call(w.owner, w.tenantA, CREATE_INVITATION, p.params)).result).toBe("created");
      const accepted = await call(user, w.tenantA, ACCEPT, [p.tokenSha]);
      expect(accepted).toMatchObject({ result: "accepted", role: "viewer", reactivated: true });
      const row = await memberRow(memberId);
      expect(row.status).toBe("active");
      expect(row.role).toBe("viewer");
      expect(row.removed_at).toBeNull();
      expect(row.removed_by).toBeNull();
      // Vuelve a verse en la lista, y otra vez se puede quitar.
      expect((await call<Json[]>(w.owner, w.tenantA, LIST)).map((m) => m.user_id)).toContain(
        user.id,
      );
      expect((await call(w.owner, w.tenantA, REMOVE, [memberId, "viewer"])).result).toBe("removed");
    });
  });
});

describe("nadie escribe directo en members", () => {
  it("ni el Dueño con su pase puede insertar, cambiar ni borrar filas de members", async () => {
    await withTx(setup, async () => {
      const salesId = await memberIdOf(w.sales);
      await asUser(setup, w.owner, w.tenantA);
      const stranger = await createUserAsPostgres();
      const insert = await expectSqlError(
        setup,
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'viewer')",
        [w.tenantA, stranger],
      );
      expect(insert.code).toBe(INSUFFICIENT_PRIVILEGE);
      const update = await expectSqlError(
        setup,
        "update public.members set role = 'admin' where id = $1",
        [salesId],
      );
      expect(update.code).toBe(INSUFFICIENT_PRIVILEGE);
      const remove = await expectSqlError(setup, "delete from public.members where id = $1", [
        salesId,
      ]);
      expect(remove.code).toBe(INSUFFICIENT_PRIVILEGE);
      await actAsPostgres(setup);
      expect((await memberRow(salesId)).role).toBe("sales");
    });
  });

  async function createUserAsPostgres(): Promise<string> {
    await actAsPostgres(setup);
    const user = await createUser(setup);
    await asUser(setup, w.owner, w.tenantA);
    return user.id;
  }
});

// --- Ayudas de las pruebas con dos conexiones reales ----------------------------------------------------
type Call = { user: TestUser; tenant: string; sql: string; params: unknown[] };
type Outcome = { ok: true; result: Json } | { ok: false; code?: string; message: string };

let monitor: Client;
beforeAll(async () => {
  monitor = await connect();
});
afterAll(async () => {
  await monitor.end();
});

const pidOf = async (client: Client) =>
  (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;

/** ¿La conexión `waiter` está esperando un bloqueo que tiene `blocker`? (se pregunta desde una tercera conexión) */
async function isBlockedBy(waiterPid: number, blockerPid: number): Promise<boolean> {
  const { rowCount } = await monitor.query(
    "select 1 from pg_stat_activity where pid = $1 and $2 = any(pg_blocking_pids($1))",
    [waiterPid, blockerPid],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * La primera llamada corre y SIGUE ABIERTA (con sus bloqueos); la segunda empieza en otra conexión. Se espera, con
 * `pg_blocking_pids`, a que la segunda esté de verdad bloqueada por la primera (nada de esperas arbitrarias); recién
 * entonces se confirma la primera. `blocked` dice si la segunda llegó a esperar (si no, la prueba no probó la carrera).
 */
async function raceBlocking(first: Call, second: Call) {
  const a = await connect();
  const b = await connect();
  try {
    const [pidA, pidB] = [await pidOf(a), await pidOf(b)];
    await a.query("begin");
    await asUser(a, first.user, first.tenant);
    const firstRows = await a.query<{ r: Json }>(first.sql, first.params);
    const firstResult = firstRows.rows[0].r;

    await b.query("begin");
    await asUser(b, second.user, second.tenant);
    let settled = false;
    const secondPromise: Promise<Outcome> = b
      .query<{ r: Json }>(second.sql, second.params)
      .then((rows) => ({ ok: true as const, result: rows.rows[0].r }))
      .catch((error: { code?: string; message: string }) => ({
        ok: false as const,
        code: error.code,
        message: error.message,
      }))
      .finally(() => {
        settled = true;
      });

    let blocked = false;
    const deadline = Date.now() + 15_000;
    while (!settled && Date.now() < deadline) {
      if (await isBlockedBy(pidB, pidA)) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await a.query("commit");
    const second_ = await secondPromise;
    await b.query(second_.ok ? "commit" : "rollback");
    return { firstResult, second: second_, blocked };
  } finally {
    await a.query("rollback").catch(() => undefined);
    await b.query("rollback").catch(() => undefined);
    await a.end();
    await b.end();
  }
}

describe("dos personas a la vez (dos conexiones reales)", () => {
  /** Una organización propia con un Dueño y las personas pedidas (las conexiones confirman: no se deshace). */
  async function freshTenant(extraRoles: string[]) {
    const owner = await createUser(setup);
    await setup.query("begin");
    const tenant = await createTenantAs(setup, owner, "76086428-5", "Carrera de equipo");
    const others: { user: TestUser; memberId: string }[] = [];
    for (const role of extraRoles) {
      const user = await createUser(setup, { meta: { full_name: `Persona ${role}` } });
      const { rows } = await setup.query<{ id: string }>(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, $3) returning id",
        [tenant, user.id, role],
      );
      others.push({ user, memberId: rows[0].id });
    }
    await setup.query("commit");
    return { owner, tenant, others };
  }

  it("el Dueño quita a un Administrador mientras este quita a otra persona: gana el Dueño y el Administrador ya no quita a nadie", async () => {
    const { owner, tenant, others } = await freshTenant(["admin", "sales"]);
    const [admin, target] = others;
    const { firstResult, second, blocked } = await raceBlocking(
      { user: owner, tenant, sql: REMOVE, params: [admin.memberId, "admin"] },
      { user: admin.user, tenant, sql: REMOVE, params: [target.memberId, "sales"] },
    );
    expect(blocked).toBe(true);
    expect(firstResult.result).toBe("removed");
    // La segunda esperó la fila de quien actúa, volvió a mirarla y ya no está activa: «sin permiso».
    expect(second.ok).toBe(false);
    expect((second as { code?: string }).code).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await memberRow(admin.memberId)).status).toBe("removed");
    expect((await memberRow(target.memberId)).status).toBe("active");
    expect(
      await count(
        "select count(*) as n from public.members where tenant_id = $1 and status = 'active'",
        [tenant],
      ),
    ).toBe(2);
  });

  it("«nadie toca al Dueño» se responde sin bloquear su fila: con esa fila bloqueada por otra conexión, el Administrador recibe la respuesta sin esperar", async () => {
    const { owner, tenant, others } = await freshTenant(["admin"]);
    const [admin] = others;
    const ownerMemberId = await memberIdOf(owner, tenant);
    const holder = await connect();
    const caller = await connect();
    try {
      // Otra conexión tiene la fila del Dueño bloqueada (como un cambio del Dueño en curso).
      await holder.query("begin");
      await holder.query("select 1 from public.members where id = $1 for update", [ownerMemberId]);
      // Si la función intentara bloquear la fila del Dueño, esperaría y fallaría con 55P03 (lock_not_available).
      await caller.query("begin");
      await caller.query("set local lock_timeout = '2s'");
      await asUser(caller, admin.user, tenant);
      for (const [sql, params] of [
        [CHANGE, [ownerMemberId, "viewer", "owner"]],
        [CHANGE, [ownerMemberId, "admin", "owner"]],
        [REMOVE, [ownerMemberId, "owner"]],
      ] as const) {
        const error = await expectSqlError(caller, sql, [...params]);
        expect(error.code).toBe(NOT_ALLOWED);
        expect(error.message).toBe("cannot_target_owner");
      }
    } finally {
      await caller.query("rollback").catch(() => undefined);
      await holder.query("rollback").catch(() => undefined);
      await caller.end();
      await holder.end();
    }
    expect(await memberRow(ownerMemberId)).toMatchObject({ status: "active", role: "owner" });
  });

  it("el Dueño sube a alguien a Administrador mientras un Administrador lo quita: el Administrador recibe «solo el Dueño»", async () => {
    const { owner, tenant, others } = await freshTenant(["admin", "sales"]);
    const [admin, target] = others;
    const { firstResult, second, blocked } = await raceBlocking(
      { user: owner, tenant, sql: CHANGE, params: [target.memberId, "admin", "sales"] },
      { user: admin.user, tenant, sql: REMOVE, params: [target.memberId, "sales"] },
    );
    expect(blocked).toBe(true);
    expect(firstResult.role).toBe("admin");
    // La regla se mira sobre la fila ya bloqueada: el rol nuevo ya maneja el equipo.
    expect(second.ok).toBe(false);
    expect((second as { code?: string }).code).toBe(INSUFFICIENT_PRIVILEGE);
    expect((second as { message: string }).message).toContain("owner_only");
    expect(await memberRow(target.memberId)).toMatchObject({ status: "active", role: "admin" });
  });

  it("dos cambios al mismo miembro a la vez, cada uno con el rol que vio: gana el primero y el otro recibe «el rol cambió»", async () => {
    const { owner, tenant, others } = await freshTenant(["admin", "sales"]);
    const [admin, target] = others;
    const { firstResult, second, blocked } = await raceBlocking(
      { user: owner, tenant, sql: CHANGE, params: [target.memberId, "viewer", "sales"] },
      { user: admin.user, tenant, sql: CHANGE, params: [target.memberId, "approver", "sales"] },
    );
    expect(blocked).toBe(true);
    expect(firstResult.role).toBe("viewer");
    expect(second.ok).toBe(false);
    expect((second as { code?: string }).code).toBe(CONFLICT);
    expect((second as { message: string }).message).toContain("role_changed");
    expect((await memberRow(target.memberId)).role).toBe("viewer");
    expect(
      await count(
        "select count(*) as n from public.audit_log where tenant_id = $1 and action = 'member.role_changed'",
        [tenant],
      ),
    ).toBe(1);
  });

  it("quitar y, a la vez, cambiar el rol del mismo miembro: gana el primero, nadie queda a medias", async () => {
    // Quitar primero: el cambio, al despertar, ya no encuentra a alguien activo.
    const one = await freshTenant(["admin", "sales"]);
    const removeFirst = await raceBlocking(
      {
        user: one.owner,
        tenant: one.tenant,
        sql: REMOVE,
        params: [one.others[1].memberId, "sales"],
      },
      {
        user: one.others[0].user,
        tenant: one.tenant,
        sql: CHANGE,
        params: [one.others[1].memberId, "viewer", "sales"],
      },
    );
    expect(removeFirst.blocked).toBe(true);
    expect(removeFirst.firstResult.result).toBe("removed");
    expect((removeFirst.second as { code?: string }).code).toBe(NOT_FOUND);
    expect(await memberRow(one.others[1].memberId)).toMatchObject({
      status: "removed",
      role: "sales",
    });

    // Cambiar primero: quitar con el rol que se veía se rechaza.
    const two = await freshTenant(["admin", "sales"]);
    const changeFirst = await raceBlocking(
      {
        user: two.others[0].user,
        tenant: two.tenant,
        sql: CHANGE,
        params: [two.others[1].memberId, "viewer", "sales"],
      },
      {
        user: two.owner,
        tenant: two.tenant,
        sql: REMOVE,
        params: [two.others[1].memberId, "sales"],
      },
    );
    expect(changeFirst.blocked).toBe(true);
    expect(changeFirst.firstResult.role).toBe("viewer");
    expect((changeFirst.second as { code?: string }).code).toBe(CONFLICT);
    expect(await memberRow(two.others[1].memberId)).toMatchObject({
      status: "active",
      role: "viewer",
    });
  });

  it.each(["change", "remove"] as const)(
    "con 29 cambios en la hora, dos cambios a la vez de la misma persona (el segundo: %s): pasa solo uno, el otro recibe «tope»",
    async (secondAction) => {
      const { tenant, others } = await freshTenant(["admin", "sales", "sales"]);
      const [admin, first, second] = others;
      // 29 cambios ya hechos en la última hora (datos confirmados: las dos conexiones tienen que verlos).
      await seedMemberChanges(admin.user, MEMBER_CHANGES_PER_HOUR - 1, { tenant });
      const raced = await raceBlocking(
        { user: admin.user, tenant, sql: CHANGE, params: [first.memberId, "viewer", "sales"] },
        {
          user: admin.user,
          tenant,
          sql: secondAction === "change" ? CHANGE : REMOVE,
          params:
            secondAction === "change"
              ? [second.memberId, "viewer", "sales"]
              : [second.memberId, "sales"],
        },
      );
      // La segunda esperó la fila de quien actúa (la tiene la primera) y, al despertar, ya ve el cambio número 30.
      expect(raced.blocked).toBe(true);
      expect(raced.firstResult.result).toBe("changed");
      expect(raced.second.ok).toBe(false);
      expect((raced.second as { code?: string }).code).toBe(TOO_MANY);
      expect((raced.second as { message: string }).message).toContain("limit_member_changes");
      expect(await memberRow(first.memberId)).toMatchObject({ status: "active", role: "viewer" });
      expect(await memberRow(second.memberId)).toMatchObject({ status: "active", role: "sales" });
      expect(
        await count(
          `select count(*) as n from public.audit_log
            where tenant_id = $1 and actor_user_id = $2 and action in ('member.role_changed', 'member.removed')`,
          [tenant, admin.user.id],
        ),
      ).toBe(MEMBER_CHANGES_PER_HOUR);
    },
  );
});

describe("invitar mientras te quitan o te bajan de rol (carrera de H-008 con H-010)", () => {
  async function freshTeam() {
    const owner = await createUser(setup);
    await setup.query("begin");
    const tenant = await createTenantAs(setup, owner, "76086428-5", "Carrera de invitaciones");
    const inviter = await createUser(setup, { meta: { full_name: "Admin Que Invita" } });
    const { rows } = await setup.query<{ id: string }>(
      "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'admin') returning id",
      [tenant, inviter.id],
    );
    await setup.query("commit");
    return { owner, tenant, inviter, inviterMemberId: rows[0].id };
  }

  type Action = "remove" | "demote";
  const actionCall = (action: Action, team: Awaited<ReturnType<typeof freshTeam>>) => ({
    user: team.owner,
    tenant: team.tenant,
    sql: action === "remove" ? REMOVE : CHANGE,
    params:
      action === "remove"
        ? [team.inviterMemberId, "admin"]
        : [team.inviterMemberId, "viewer", "admin"],
  });
  const pendingBy = (tenant: string, user: TestUser) =>
    count(
      "select count(*) as n from public.invitations where tenant_id = $1 and invited_by = $2 and status = 'pending'",
      [tenant, user.id],
    );
  const invitationsBy = (tenant: string, user: TestUser) =>
    count("select count(*) as n from public.invitations where tenant_id = $1 and invited_by = $2", [
      tenant,
      user.id,
    ]);

  it.each(["remove", "demote"] as const)(
    "1/2 · %s ANTES: la persona que invitaba recibe «sin permiso» y no queda ninguna invitación suya",
    async (action) => {
      const team = await freshTeam();
      const invite = prepareInvitation(`nueva-${randomUUID().slice(0, 8)}@ejemplo.test`, "viewer");
      const { firstResult, second, blocked } = await raceBlocking(actionCall(action, team), {
        user: team.inviter,
        tenant: team.tenant,
        sql: CREATE_INVITATION,
        params: invite.params,
      });
      // La segunda esperó la fila de quien invita (la tiene bloqueada quien lo quita o le baja el rol).
      expect(blocked).toBe(true);
      expect(["removed", "changed"]).toContain(firstResult.result);
      expect(second.ok).toBe(false);
      expect((second as { code?: string }).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await invitationsBy(team.tenant, team.inviter)).toBe(0);
      expect(await pendingBy(team.tenant, team.inviter)).toBe(0);
      // Nada de correo ni de aviso quedó anotado.
      expect(
        await count("select count(*) as n from public.email_messages where invitation_id = $1", [
          invite.id,
        ]),
      ).toBe(0);
    },
  );

  it.each(["remove", "demote"] as const)(
    "1/2 · la invitación en curso se guarda ANTES (%s espera): la cancelación la ve y no queda ninguna pendiente",
    async (action) => {
      const team = await freshTeam();
      const invite = prepareInvitation(
        `en-curso-${randomUUID().slice(0, 8)}@ejemplo.test`,
        "viewer",
      );
      // Primero invita (queda abierta, con su bloqueo); la persona que quita o baja de rol tiene que esperar.
      const { firstResult, second, blocked } = await raceBlocking(
        {
          user: team.inviter,
          tenant: team.tenant,
          sql: CREATE_INVITATION,
          params: invite.params,
        },
        actionCall(action, team),
      );
      expect(firstResult.result).toBe("created");
      expect(blocked).toBe(true);
      expect(second.ok).toBe(true);
      expect((second as { ok: true; result: Json }).result.cancelled_invitations).toBe(1);
      expect(await invitationsBy(team.tenant, team.inviter)).toBe(1);
      expect(await pendingBy(team.tenant, team.inviter)).toBe(0);
      const row = await invitationStatus(invite.id);
      expect(row).toMatchObject({ status: "revoked", revoke_reason: "inviter_removed" });
    },
  );

  it("3 · la invitación cancelada no revive si la persona vuelve con un rol que maneja el equipo; la que nunca se guardó no existe", async () => {
    const team = await freshTeam();
    // (a) La que alcanzó a guardarse (y la cancelación la vio).
    const guest = await createUser(setup);
    const kept = prepareInvitation(guest.email, "sales");
    const raced = await raceBlocking(
      { user: team.inviter, tenant: team.tenant, sql: CREATE_INVITATION, params: kept.params },
      actionCall("remove", team),
    );
    expect(raced.blocked).toBe(true);
    expect(await invitationStatus(kept.id)).toMatchObject({
      status: "revoked",
      revoke_reason: "inviter_removed",
    });

    // (b) La que no alcanzó: la persona ya está quitada, así que no se crea ni queda rastro.
    const never = prepareInvitation(`nunca-${randomUUID().slice(0, 8)}@ejemplo.test`, "viewer");
    await setup.query("begin");
    await asUser(setup, team.inviter, team.tenant);
    const refused = await expectSqlError(setup, CREATE_INVITATION, never.params);
    await setup.query("rollback");
    // Ya no es miembro: «no encontrado» (la carrera, en cambio, da «sin permiso»: ver las pruebas de arriba).
    expect(refused.code).toBe(NOT_FOUND);
    expect(await invitationStatus(never.id)).toBeUndefined();

    // La persona vuelve: el Dueño la invita de nuevo como Administradora y ella acepta (se reactiva su misma fila).
    const comeback = prepareInvitation(team.inviter.email, "admin");
    await setup.query("begin");
    expect((await call(team.owner, team.tenant, CREATE_INVITATION, comeback.params)).result).toBe(
      "created",
    );
    expect(await call(team.inviter, team.tenant, ACCEPT, [comeback.tokenSha])).toMatchObject({
      result: "accepted",
      role: "admin",
      reactivated: true,
    });
    await setup.query("commit");
    expect((await memberRow(team.inviterMemberId)).status).toBe("active");

    // Ya es Administradora otra vez, y aun así ninguna invitación vieja revive: sigue cancelada y no se puede usar.
    expect(await pendingBy(team.tenant, team.inviter)).toBe(0);
    expect(await invitationStatus(kept.id)).toMatchObject({ status: "revoked" });
    await setup.query("begin");
    const attempt = await call(guest, team.tenant, ACCEPT, [kept.tokenSha]);
    await setup.query("commit");
    expect(attempt.result).toBe("inviter_inactive");
    expect(
      await count(
        "select count(*) as n from public.members where tenant_id = $1 and user_id = $2",
        [team.tenant, guest.id],
      ),
    ).toBe(0);
  });
});

describe("reenviar mientras te quitan o te bajan de rol (el bloqueo de resend_invitation)", () => {
  /** Una organización propia con un Administrador que ya tiene una invitación pendiente lista para reenviar. */
  async function teamWithPendingInvitation() {
    const owner = await createUser(setup);
    await setup.query("begin");
    const tenant = await createTenantAs(setup, owner, "76086428-5", "Carrera de reenvíos");
    const inviter = await createUser(setup, { meta: { full_name: "Admin Que Reenvía" } });
    const { rows } = await setup.query<{ id: string }>(
      "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'admin') returning id",
      [tenant, inviter.id],
    );
    const invite = prepareInvitation(`reenvio-${randomUUID().slice(0, 8)}@ejemplo.test`, "viewer");
    expect((await call(inviter, tenant, CREATE_INVITATION, invite.params)).result).toBe("created");
    // Ya pasó el tiempo mínimo entre un envío y el siguiente.
    await setup.query(
      "update public.invitations set last_sent_at = now() - interval '1 hour' where id = $1",
      [invite.id],
    );
    await setup.query("commit");
    return { owner, tenant, inviter, inviterMemberId: rows[0].id, invite };
  }
  type Team = Awaited<ReturnType<typeof teamWithPendingInvitation>>;

  const resendCall = (team: Team) => {
    const { sha } = newToken();
    const mailId = randomUUID();
    return {
      mailId,
      call: {
        user: team.inviter,
        tenant: team.tenant,
        sql: RESEND,
        params: [
          team.invite.id,
          invitationEmailBinding(sha, team.invite.email),
          sha,
          mailId,
          `v1.cifrado.correo.${mailId}`,
        ],
      },
    };
  };
  const ownerAction = (action: "remove" | "demote", team: Team) => ({
    user: team.owner,
    tenant: team.tenant,
    sql: action === "remove" ? REMOVE : CHANGE,
    params:
      action === "remove"
        ? [team.inviterMemberId, "admin"]
        : [team.inviterMemberId, "viewer", "admin"],
  });
  const mailsOf = (invitationId: string) =>
    count(
      "select count(*) as n from public.email_messages where invitation_id = $1 and kind = 'invitation'",
      [invitationId],
    );

  it.each(["remove", "demote"] as const)(
    "%s ANTES: quien reenviaba espera, recibe «sin permiso» y no sale ningún correo a su nombre",
    async (action) => {
      const team = await teamWithPendingInvitation();
      const resend = resendCall(team);
      const { firstResult, second, blocked } = await raceBlocking(
        ownerAction(action, team),
        resend.call,
      );
      // El reenvío esperó la fila de quien reenvía (la tiene bloqueada quien lo quita o le baja el rol).
      expect(blocked).toBe(true);
      expect(["removed", "changed"]).toContain(firstResult.result);
      expect(firstResult.cancelled_invitations).toBe(1);
      expect(second.ok).toBe(false);
      expect((second as { code?: string }).code).toBe(INSUFFICIENT_PRIVILEGE);
      // Solo queda el correo de la invitación original; el del reenvío nunca se anotó.
      expect(await mailsOf(team.invite.id)).toBe(1);
      expect(
        await count("select count(*) as n from public.email_messages where id = $1", [
          resend.mailId,
        ]),
      ).toBe(0);
      expect(await invitationStatus(team.invite.id)).toMatchObject({
        status: "revoked",
        revoke_reason: "inviter_removed",
      });
    },
  );

  it.each(["remove", "demote"] as const)(
    "el reenvío en curso termina ANTES (%s espera): la cancelación lo ve y la invitación queda cancelada",
    async (action) => {
      const team = await teamWithPendingInvitation();
      const resend = resendCall(team);
      const { firstResult, second, blocked } = await raceBlocking(
        resend.call,
        ownerAction(action, team),
      );
      expect(firstResult.result).toBe("resent");
      expect(blocked).toBe(true);
      expect(second.ok).toBe(true);
      expect((second as { ok: true; result: Json }).result.cancelled_invitations).toBe(1);
      expect(await invitationStatus(team.invite.id)).toMatchObject({
        status: "revoked",
        revoke_reason: "inviter_removed",
      });
    },
  );
});

/**
 * Reenvía la invitación `p` como `user`, atándola al correo `toEmail` (como lo haría quien llama la base directo): el
 * código nuevo (`sha`) y el vínculo con ese correo. Antes se pasa el tiempo mínimo entre envíos.
 */
async function resendAs(user: TestUser, p: Prepared, toEmail: string, tenant = w.tenantA) {
  await actAsPostgres(setup);
  await setup.query(
    "update public.invitations set last_sent_at = now() - interval '1 hour' where id = $1",
    [p.id],
  );
  const { sha } = newToken();
  const mailId = randomUUID();
  const result = await call(user, tenant, RESEND, [
    p.id,
    invitationEmailBinding(sha, toEmail),
    sha,
    mailId,
    `v1.cifrado.correo.${mailId}`,
  ]);
  return { sha, mailId, result };
}

const resentBy = async (id: string) => {
  await actAsPostgres(setup);
  return (
    await setup.query<{ resent_by: string | null }>(
      "select resent_by from public.invitations where id = $1",
      [id],
    )
  ).rows[0].resent_by;
};

/** Lo que el Dueño ve en `members.invited_by` de esa persona, con su propia sesión. */
const invitedByAsOwner = async (user: TestUser, tenant = w.tenantA) => {
  await asUser(setup, w.owner, tenant);
  const { rows } = await setup.query<{ invited_by: string | null }>(
    "select invited_by from public.members where tenant_id = $1 and user_id = $2",
    [tenant, user.id],
  );
  await actAsPostgres(setup);
  return rows[0]?.invited_by;
};

describe("invitaciones que la persona reenvió (corrección de la revisión del 2026-11-06)", () => {
  it("M1 · el ataque exacto: un Administrador reenvía la invitación del Dueño a un cómplice y lo quitan; la invitación se cancela y el cómplice no entra", async () => {
    await withTx(setup, async () => {
      const x = await addMember("admin", w.tenantA, "Admin Que Se Va");
      const accomplice = await createUser(setup);
      // El Dueño invita a un Comercial; X la reenvía atada al correo de su cómplice, con un código que X conoce.
      const p = await inviteAs(w.owner, "sales");
      const resent = await resendAs(x.user, p, accomplice.email);
      expect(resent.result.result).toBe("resent");
      expect(await resentBy(p.id)).toBe(x.user.id);
      expect((await invitationStatus(p.id)).status).toBe("pending");

      // Lo quitan: la limpieza ve que X reenvió esa invitación y la cancela (antes quedaba viva).
      const removed = await call(w.owner, w.tenantA, REMOVE, [x.memberId, "admin"]);
      expect(removed).toMatchObject({ result: "removed", cancelled_invitations: 1 });
      expect(await invitationStatus(p.id)).toMatchObject({
        status: "revoked",
        revoke_reason: "inviter_removed",
        revoked_by: w.owner.id,
      });
      const audit = await auditRows("member.removed", x.memberId);
      expect(audit[0].details).toEqual({ role: "admin", cancelled_invitations: 1 });

      // El cómplice usa el código de X: no entra.
      const attempt = await call(accomplice, w.tenantA, ACCEPT, [resent.sha]);
      expect(attempt.result).toBe("inviter_inactive");
      expect(
        await count(
          "select count(*) as n from public.members where tenant_id = $1 and user_id = $2",
          [w.tenantA, accomplice.id],
        ),
      ).toBe(0);
    });
  });

  it("M2 · lo mismo si en vez de quitarlo le bajan el rol a uno que no maneja el equipo", async () => {
    await withTx(setup, async () => {
      const x = await addMember("admin", w.tenantA, "Admin Que Baja");
      const accomplice = await createUser(setup);
      const p = await inviteAs(w.owner, "sales");
      const resent = await resendAs(x.user, p, accomplice.email);
      const changed = await call(w.owner, w.tenantA, CHANGE, [x.memberId, "sales", "admin"]);
      expect(changed).toMatchObject({ result: "changed", role: "sales", cancelled_invitations: 1 });
      expect(await invitationStatus(p.id)).toMatchObject({
        status: "revoked",
        revoke_reason: "inviter_removed",
        revoked_by: w.owner.id,
      });
      expect((await call(accomplice, w.tenantA, ACCEPT, [resent.sha])).result).toBe(
        "inviter_inactive",
      );
      const audit = await auditRows("member.role_changed", x.memberId);
      expect(audit[0].details).toEqual({
        old_role: "admin",
        new_role: "sales",
        cancelled_invitations: 1,
      });
    });
  });

  it.each(["resender", "creator"] as const)(
    "M3 · creada por un Administrador (B) y reenviada por otro (X): se cancela cuando sale %s",
    async (leaver) => {
      await withTx(setup, async () => {
        const b = await addMember("admin", w.tenantA, "Admin Creador");
        const x = await addMember("admin", w.tenantA, "Admin Reenviador");
        const p = await inviteAs(b.user, "sales");
        await resendAs(x.user, p, `otro-${randomUUID().slice(0, 8)}@ejemplo.test`);
        expect(await resentBy(p.id)).toBe(x.user.id);
        const out = leaver === "resender" ? x : b;
        const removed = await call(w.owner, w.tenantA, REMOVE, [out.memberId, "admin"]);
        expect(removed.cancelled_invitations).toBe(1);
        expect(await invitationStatus(p.id)).toMatchObject({
          status: "revoked",
          revoke_reason: "inviter_removed",
        });
      });
    },
  );

  it("M4 · la reenvía el Dueño: si la creó X se cancela al salir X (cuenta 1, no 2); si la creó y reenvió el Dueño, no se toca", async () => {
    await withTx(setup, async () => {
      const x = await addMember("admin", w.tenantA, "Admin Creador");
      const byX = await inviteAs(x.user, "viewer");
      await resendAs(w.owner, byX, byX.email);
      expect(await resentBy(byX.id)).toBe(w.owner.id);
      const byOwner = await inviteAs(w.owner, "viewer");
      await resendAs(w.owner, byOwner, byOwner.email);
      expect(await resentBy(byOwner.id)).toBe(w.owner.id);

      const removed = await call(w.owner, w.tenantA, REMOVE, [x.memberId, "admin"]);
      expect(removed.cancelled_invitations).toBe(1);
      expect((await invitationStatus(byX.id)).status).toBe("revoked");
      expect((await invitationStatus(byOwner.id)).status).toBe("pending");
    });
  });

  it("M5 · X crea y reenvía la suya: al salir cuenta una sola vez", async () => {
    await withTx(setup, async () => {
      const x = await addMember("admin", w.tenantA, "Admin Que Crea Y Reenvía");
      const p = await inviteAs(x.user, "viewer");
      await resendAs(x.user, p, p.email);
      expect(await resentBy(p.id)).toBe(x.user.id);
      const removed = await call(w.owner, w.tenantA, REMOVE, [x.memberId, "admin"]);
      expect(removed.cancelled_invitations).toBe(1);
      expect((await invitationStatus(p.id)).status).toBe("revoked");
    });
  });

  it("M6 · si después de X la reenvía el Dueño al correo real, al quitar a X no se cancela nada y el código de X deja de servir", async () => {
    await withTx(setup, async () => {
      const x = await addMember("admin", w.tenantA, "Admin Desviado");
      const accomplice = await createUser(setup);
      const real = await createUser(setup);
      const p = await inviteAs(w.owner, "sales");
      const viaX = await resendAs(x.user, p, accomplice.email);
      const viaOwner = await resendAs(w.owner, p, real.email);
      expect(await resentBy(p.id)).toBe(w.owner.id);

      const removed = await call(w.owner, w.tenantA, REMOVE, [x.memberId, "admin"]);
      expect(removed.cancelled_invitations).toBe(0);
      expect((await invitationStatus(p.id)).status).toBe("pending");
      // El código que X conocía ya no existe (el reenvío del Dueño lo reemplazó).
      expect((await call(accomplice, w.tenantA, ACCEPT, [viaX.sha])).result).toBe("not_found");
      // La persona real entra con el código del Dueño.
      expect((await call(real, w.tenantA, ACCEPT, [viaOwner.sha])).result).toBe("accepted");
      // Quien envió el enlace aceptado fue el Dueño: figura él como quien invitó (D3).
      expect(await invitedByAsOwner(real)).toBe(w.owner.id);
    });
  });

  it("M7 · X es Administrador en A y en B: al quitarlo de A se cancela solo lo que reenvió en A", async () => {
    await withTx(setup, async () => {
      const x = await addMember("admin", w.tenantA, "Admin En Dos");
      await actAsPostgres(setup);
      await setup.query(
        "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'admin')",
        [w.tenantB, x.user.id],
      );
      const inA = await inviteAs(w.owner, "sales", w.tenantA);
      const inB = await inviteAs(w.ownerB, "sales", w.tenantB);
      await resendAs(x.user, inA, inA.email, w.tenantA);
      await resendAs(x.user, inB, inB.email, w.tenantB);
      expect(await resentBy(inA.id)).toBe(x.user.id);
      expect(await resentBy(inB.id)).toBe(x.user.id);

      const removed = await call(w.owner, w.tenantA, REMOVE, [x.memberId, "admin"]);
      expect(removed.cancelled_invitations).toBe(1);
      expect((await invitationStatus(inA.id)).status).toBe("revoked");
      expect((await invitationStatus(inB.id)).status).toBe("pending");
    });
  });

  it("M8 · D3 sin carrera: X reenvía al cómplice y el cómplice acepta ANTES de que quiten a X: queda a nombre de X, el Dueño lo puede leer con su sesión, y al quitar a X el cómplice sigue y sigue a nombre de X", async () => {
    await withTx(setup, async () => {
      const x = await addMember("admin", w.tenantA, "Admin Desviado Visible");
      const accomplice = await createUser(setup);
      const p = await inviteAs(w.owner, "sales");
      const viaX = await resendAs(x.user, p, accomplice.email);
      expect((await call(accomplice, w.tenantA, ACCEPT, [viaX.sha])).result).toBe("accepted");

      // El desvío ya no queda oculto: el Dueño lee quién envió el enlace.
      expect(await invitedByAsOwner(accomplice)).toBe(x.user.id);
      const accepted = (await auditRows("invitation.accepted", p.id))[0];
      expect(accepted.details).toMatchObject({ created_by: w.owner.id, sent_by: x.user.id });
      // La invitación sigue a nombre de quien la creó.
      await actAsPostgres(setup);
      expect(
        (await setup.query("select invited_by from public.invitations where id = $1", [p.id]))
          .rows[0].invited_by,
      ).toBe(w.owner.id);

      // Quitan a X: no hay nada pendiente que cancelar; la membresía no se deshace (decisión del 2026-11-06) y sigue a
      // nombre de X (para sacarla, el Dueño la quita).
      const removed = await call(w.owner, w.tenantA, REMOVE, [x.memberId, "admin"]);
      expect(removed.cancelled_invitations).toBe(0);
      expect(await invitedByAsOwner(accomplice)).toBe(x.user.id);
      expect((await memberRow(await memberIdOf(accomplice))).status).toBe("active");
    });
  });

  /**
   * Una invitación pendiente montada a mano como la dejaría una carrera de relojes: `send_count` 2, `resent_by` = X y dos
   * correos con el MISMO `created_at` (solo pasa si se crean en una misma transacción). El id del correo del Dueño es
   * menor o mayor que el de X, según se pida.
   */
  async function tiedInvitation(x: TestUser, ownerMailId: "smaller" | "larger") {
    const p = await inviteAs(w.owner, "viewer");
    await actAsPostgres(setup);
    const first = (
      await setup.query<{ id: string }>(
        "select id from public.email_messages where invitation_id = $1 and kind = 'invitation'",
        [p.id],
      )
    ).rows[0];
    let xMailId = randomUUID();
    while (xMailId < first.id === (ownerMailId === "smaller")) xMailId = randomUUID();
    await setup.query(
      `insert into public.email_messages
         (id, tenant_id, invitation_id, kind, to_email_enc, to_email_hash, provider, status, created_by, created_at)
       values ($1, $2, $3, 'invitation', $4, $5, 'pending', 'pending', $6,
                 (select m.created_at from public.email_messages m
                   where m.invitation_id = $3 and m.kind = 'invitation' order by m.created_at limit 1))`,
      [xMailId, w.tenantA, p.id, `v1.cifrado.correo.${xMailId}`, sha256Hex(`huella|${p.id}`), x.id],
    );
    await setup.query(
      "update public.invitations set send_count = 2, resent_by = $2 where id = $1",
      [p.id, x.id],
    );
    // El empate es de verdad: los dos correos tienen exactamente el mismo `created_at`.
    expect(
      await setup
        .query(
          "select 1 from public.email_messages where invitation_id = $1 and kind = 'invitation' group by created_at",
          [p.id],
        )
        .then((r) => r.rowCount),
    ).toBe(1);
    return p;
  }

  it.each(["smaller", "larger"] as const)(
    "M9 · menor 1: repetir la limpieza no pisa `resent_by` aunque dos correos empaten en `created_at` (el id del correo del Dueño es el %s)",
    async (ownerMailId) => {
      await withTx(setup, async () => {
        const x = await addMember("admin", w.tenantA, "Admin Que Reenvió");
        const p = await tiedInvitation(x.user, ownerMailId);
        expect(await resentBy(p.id)).toBe(x.user.id);
        // Solo se comprueba esta fila: la base local tiene datos confirmados por otras pruebas.
        for (let run = 0; run < 2; run++) {
          await actAsPostgres(setup);
          await setup.query("select app.reconcile_invitation_senders()");
          expect(await resentBy(p.id), `limpieza n.° ${run + 1}`).toBe(x.user.id);
        }
        // El ataque sigue cerrado: al quitar a X, la invitación que reenvió se cancela.
        const removed = await call(w.owner, w.tenantA, REMOVE, [x.memberId, "admin"]);
        expect(removed.cancelled_invitations).toBe(1);
        expect((await invitationStatus(p.id)).status).toBe("revoked");
      });
    },
  );

  it("una invitación que nunca se reenvió queda con `resent_by` vacío; reenviar lo llena y otro reenvío lo reemplaza", async () => {
    await withTx(setup, async () => {
      const x = await addMember("admin", w.tenantA, "Admin Reenviador");
      const p = await inviteAs(w.owner, "viewer");
      expect(await resentBy(p.id)).toBeNull();
      await resendAs(x.user, p, p.email);
      expect(await resentBy(p.id)).toBe(x.user.id);
      await resendAs(w.owner, p, p.email);
      expect(await resentBy(p.id)).toBe(w.owner.id);
    });
  });
});

describe("las ayudas de quien reenvía no las ejecuta nadie con un pase", () => {
  it("`invitation_sender_ok`, `invitation_senders_ok` y la limpieza no las ejecutan `anon` ni `authenticated`", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<{ sig: string; anon: boolean; auth: boolean; pub: boolean }>(
      `select s.sig,
              has_function_privilege('anon', s.sig, 'EXECUTE') as anon,
              has_function_privilege('authenticated', s.sig, 'EXECUTE') as auth,
              has_function_privilege('public', s.sig, 'EXECUTE') as pub
         from (values ('app.invitation_sender_ok(uuid, text, uuid)'),
                      ('app.invitation_senders_ok(uuid, text, uuid, uuid)'),
                      ('app.reconcile_invitation_senders()')) as s(sig)`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows)
      expect(row, row.sig).toMatchObject({ anon: false, auth: false, pub: false });
  });
});

describe("reenviar y quitar a la vez (dos conexiones reales): la invitación reenviada", () => {
  /**
   * Una organización propia con un Dueño, un Administrador X y una invitación a un Comercial hecha por el Dueño, lista
   * para reenviar. `accomplice` es la persona a cuyo correo X la quiere atar.
   */
  async function teamWithOwnersInvitation() {
    const owner = await createUser(setup);
    await setup.query("begin");
    const tenant = await createTenantAs(setup, owner, "76086428-5", "Carrera de reenviadas");
    const x = await createUser(setup, { meta: { full_name: "Admin Que Reenvía" } });
    const { rows } = await setup.query<{ id: string }>(
      "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'admin') returning id",
      [tenant, x.id],
    );
    const accomplice = await createUser(setup);
    const invite = prepareInvitation(`dueno-${randomUUID().slice(0, 8)}@ejemplo.test`, "sales");
    expect((await call(owner, tenant, CREATE_INVITATION, invite.params)).result).toBe("created");
    await setup.query(
      "update public.invitations set last_sent_at = now() - interval '1 hour' where id = $1",
      [invite.id],
    );
    await setup.query("commit");
    return { owner, tenant, x, xMemberId: rows[0].id, accomplice, invite };
  }
  type Team = Awaited<ReturnType<typeof teamWithOwnersInvitation>>;

  const xResends = (team: Team) => {
    const { sha } = newToken();
    const mailId = randomUUID();
    return {
      sha,
      mailId,
      call: {
        user: team.x,
        tenant: team.tenant,
        sql: RESEND,
        params: [
          team.invite.id,
          invitationEmailBinding(sha, team.accomplice.email),
          sha,
          mailId,
          `v1.cifrado.correo.${mailId}`,
        ],
      },
    };
  };
  const ownerRemovesX = (team: Team) => ({
    user: team.owner,
    tenant: team.tenant,
    sql: REMOVE,
    params: [team.xMemberId, "admin"],
  });
  const detail = async (id: string) => {
    await actAsPostgres(setup);
    return (
      await setup.query(
        "select status, revoke_reason, resent_by, send_count, token_sha256 from public.invitations where id = $1",
        [id],
      )
    ).rows[0];
  };

  it("R1 · X reenvía primero y el Dueño lo quita después: queda 1 cancelada y el cómplice recibe «quien te invitó ya no puede»", async () => {
    const team = await teamWithOwnersInvitation();
    const resend = xResends(team);
    const { firstResult, second, blocked } = await raceBlocking(resend.call, ownerRemovesX(team));
    expect(firstResult.result).toBe("resent");
    // Quitar a X esperó a que X terminara de reenviar (X tiene su fila de miembro bloqueada).
    expect(blocked).toBe(true);
    expect(second.ok).toBe(true);
    expect((second as { ok: true; result: Json }).result.cancelled_invitations).toBe(1);
    expect(await detail(team.invite.id)).toMatchObject({
      status: "revoked",
      revoke_reason: "inviter_removed",
      resent_by: team.x.id,
    });
    await withTx(setup, async () => {
      expect((await call(team.accomplice, team.tenant, ACCEPT, [resend.sha])).result).toBe(
        "inviter_inactive",
      );
    });
    expect(
      await count(
        "select count(*) as n from public.members where tenant_id = $1 and user_id = $2",
        [team.tenant, team.accomplice.id],
      ),
    ).toBe(0);
  });

  it("R2 · el Dueño actúa primero y el reenvío espera: X recibe «sin permiso» y la invitación queda intacta", async () => {
    const team = await teamWithOwnersInvitation();
    const before = await detail(team.invite.id);
    const resend = xResends(team);
    const { firstResult, second, blocked } = await raceBlocking(ownerRemovesX(team), resend.call);
    expect(blocked).toBe(true);
    expect(firstResult).toMatchObject({ result: "removed", cancelled_invitations: 0 });
    expect(second.ok).toBe(false);
    expect((second as { code?: string }).code).toBe(INSUFFICIENT_PRIVILEGE);
    // Mismo código, nadie reenvió, sin correo nuevo, sigue pendiente.
    const after = await detail(team.invite.id);
    expect(after).toMatchObject({ status: "pending", resent_by: null });
    expect(after.token_sha256).toBe(before.token_sha256);
    expect(after.send_count).toBe(before.send_count);
    expect(
      await count("select count(*) as n from public.email_messages where id = $1", [resend.mailId]),
    ).toBe(0);
  });

  it("R3 · el cómplice acepta primero y luego quitan a X: sin interbloqueo, nada que cancelar y el cómplice queda en el equipo, a nombre de X y legible por el Dueño con su sesión (D3)", async () => {
    const team = await teamWithOwnersInvitation();
    // X ya había reenviado antes de la carrera.
    const resend = xResends(team);
    await setup.query("begin");
    await call(team.x, team.tenant, RESEND, resend.call.params);
    await setup.query("commit");
    const accept = {
      user: team.accomplice,
      tenant: team.tenant,
      sql: ACCEPT,
      params: [resend.sha],
    };
    const { firstResult, second, blocked } = await raceBlocking(accept, ownerRemovesX(team));
    expect(blocked).toBe(true);
    expect(firstResult).toMatchObject({ result: "accepted", role: "sales" });
    expect(second.ok).toBe(true);
    expect((second as { ok: true; result: Json }).result.cancelled_invitations).toBe(0);
    expect((await detail(team.invite.id)).status).toBe("accepted");
    await withTx(setup, async () => {
      const members = await call<{ user_id: string }[]>(team.owner, team.tenant, LIST);
      expect(members.map((m) => m.user_id)).toContain(team.accomplice.id);
      // D3: el desvío queda a la vista. El Dueño lee con su sesión que quien envió el enlace fue X...
      await asUser(setup, team.owner, team.tenant);
      const row = await setup.query<{ invited_by: string }>(
        "select invited_by from public.members where tenant_id = $1 and user_id = $2",
        [team.tenant, team.accomplice.id],
      );
      await actAsPostgres(setup);
      expect(row.rows[0].invited_by).toBe(team.x.id);
      // ...y la auditoría anota quién la creó y quién envió el enlace.
      const audit = await setup.query<{ details: Json }>(
        "select details from public.audit_log where tenant_id = $1 and action = 'invitation.accepted' and resource_id = $2",
        [team.tenant, team.invite.id],
      );
      expect(audit.rows[0].details).toMatchObject({
        created_by: team.owner.id,
        sent_by: team.x.id,
      });
    });
  });
});

describe("las filas de quien se fue, solo para quien maneja el equipo", () => {
  it("el Aprobador, el Comercial y el Observador no ven la fila de un ex miembro (ni cuándo ni quién lo quitó), pero sí a su equipo activo y el nombre del ex miembro", async () => {
    await withTx(setup, async () => {
      const gone = await addMember("sales", w.tenantA, "Fila Reservada");
      await call(w.owner, w.tenantA, REMOVE, [gone.memberId, "sales"]);
      const active = await count(
        "select count(*) as n from public.members where tenant_id = $1 and status = 'active'",
        [w.tenantA],
      );
      for (const reader of [w.approver, w.sales, w.viewer]) {
        await asUser(setup, reader, w.tenantA);
        const removedRow = await setup.query(
          "select removed_at, removed_by from public.members where id = $1",
          [gone.memberId],
        );
        expect(removedRow.rowCount).toBe(0);
        const team = await setup.query<{ status: string }>(
          "select status from public.members where tenant_id = $1",
          [w.tenantA],
        );
        expect(team.rowCount).toBe(active);
        expect(team.rows.every((row) => row.status === "active")).toBe(true);
        // El nombre de quien se fue se sigue leyendo (lo usa la cotización como autor).
        const name = await setup.query<{ full_name: string }>(
          "select full_name from public.profiles where user_id = $1",
          [gone.user.id],
        );
        expect(name.rows).toEqual([{ full_name: "Fila Reservada" }]);
        await actAsPostgres(setup);
      }
      // El Dueño y los Administradores sí la ven (el registro de actividad dice a quién afectó cada cambio).
      for (const reader of [w.owner, w.admin]) {
        await asUser(setup, reader, w.tenantA);
        const rows = await setup.query<{ removed_by: string }>(
          "select removed_by from public.members where id = $1",
          [gone.memberId],
        );
        expect(rows.rows).toEqual([{ removed_by: w.owner.id }]);
        await actAsPostgres(setup);
      }
      // Quien se fue sigue viendo su propia fila (el selector de organizaciones la necesita).
      await asUser(setup, gone.user, w.tenantA);
      expect(
        (await setup.query("select 1 from public.members where id = $1", [gone.memberId])).rowCount,
      ).toBe(1);
      await actAsPostgres(setup);
    });
  });
});

describe("de profiles, solo el nombre", () => {
  it("la Dueña lee el nombre de un ex miembro y de un miembro activo, pero created_at, updated_at y last_tenant_id le dan «sin permiso»", async () => {
    await withTx(setup, async () => {
      const gone = await addMember("sales", w.tenantA, "Ex Miembro Reservado");
      await call(w.owner, w.tenantA, REMOVE, [gone.memberId, "sales"]);
      for (const person of [gone.user, w.sales]) {
        await asUser(setup, w.owner, w.tenantA);
        const ok = await setup.query<{ user_id: string; tenant_id: string; full_name: string }>(
          "select user_id, tenant_id, full_name from public.profiles where user_id = $1",
          [person.id],
        );
        expect(ok.rowCount, "el nombre se sigue leyendo").toBe(1);
        for (const column of ["created_at", "updated_at", "last_tenant_id"]) {
          const error = await expectSqlError(
            setup,
            `select ${column} from public.profiles where user_id = $1`,
            [person.id],
          );
          expect(error.code, `${column} de ${person.id}`).toBe(INSUFFICIENT_PRIVILEGE);
        }
        const all = await expectSqlError(
          setup,
          "select * from public.profiles where user_id = $1",
          [person.id],
        );
        expect(all.code).toBe(INSUFFICIENT_PRIVILEGE);
        await actAsPostgres(setup);
      }
    });
  });

  it("las únicas columnas legibles para una persona con pase son user_id, tenant_id y full_name", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'profiles' and grantee = 'authenticated'
          and privilege_type = 'SELECT' order by 1`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["full_name", "tenant_id", "user_id"]);
  });
});

describe("estructura", () => {
  it("las funciones son solo para quien tiene pase de persona, con ruta de búsqueda fija", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<{
      name: string;
      anon: boolean;
      auth: boolean;
      definer: boolean;
      config: string[] | null;
    }>(
      `select p.proname as name,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              p.prosecdef as definer, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('list_members', 'change_member_role', 'remove_member')`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual([
      "change_member_role",
      "list_members",
      "remove_member",
    ]);
    for (const fn of rows) {
      expect(fn.anon, fn.name).toBe(false);
      expect(fn.auth, fn.name).toBe(true);
      expect(fn.definer, fn.name).toBe(true);
      expect(fn.config, fn.name).toContain('search_path=""');
    }
    // La ayuda interna no la ejecuta nadie con un pase.
    const helper = await setup.query<{ auth: boolean; anon: boolean }>(
      `select has_function_privilege('authenticated', 'app.cancel_member_invitations(uuid, uuid, uuid)', 'EXECUTE') as auth,
              has_function_privilege('anon', 'app.cancel_member_invitations(uuid, uuid, uuid)', 'EXECUTE') as anon`,
    );
    expect(helper.rows[0]).toEqual({ auth: false, anon: false });
    // El tope tampoco; las personas de la organización sí (las usa la política de `profiles`), nunca anon.
    const more = await setup.query<{
      cap_auth: boolean;
      count_auth: boolean;
      people_auth: boolean;
      people_anon: boolean;
    }>(
      `select has_function_privilege('authenticated', 'app.member_change_max_per_hour()', 'EXECUTE') as cap_auth,
              has_function_privilege('authenticated', 'app.member_changes_exhausted(uuid, uuid)', 'EXECUTE') as count_auth,
              has_function_privilege('authenticated', 'app.current_tenant_people()', 'EXECUTE') as people_auth,
              has_function_privilege('anon', 'app.current_tenant_people()', 'EXECUTE') as people_anon`,
    );
    expect(more.rows[0]).toEqual({
      cap_auth: false,
      count_auth: false,
      people_auth: true,
      people_anon: false,
    });
  });

  it("ninguna de las funciones recibe una organización como argumento", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('list_members', 'change_member_role', 'remove_member')`,
    );
    for (const row of rows) expect(row.args).not.toMatch(/tenant/i);
  });
});
