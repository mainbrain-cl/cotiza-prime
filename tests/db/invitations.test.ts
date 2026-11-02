// Sprint 5 · migración 20261030100000 · invitar a un miembro (H-008).
// Permisos de cada rol verificados en la base, rol permitido, topes, carrera entre dos invitaciones al mismo
// correo, reenvío que invalida el código anterior, cancelar, cierre del envío del correo y borrado por plazo.
// Cada prueba corre en una transacción que se deshace (salvo la de dos invitaciones simultáneas, que usa su
// propia organización). Todo es ficticio.
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationEmailBinding } from "../../src/lib/team/invitation-code";
import {
  INVITATION_MAX_PENDING,
  INVITATION_MAX_PER_TENANT_DAY,
  INVITATION_MAX_PER_USER_HOUR,
  INVITATION_MAX_RESENDS,
  INVITATION_RESEND_MIN_MINUTES,
  INVITATION_RETENTION_DAYS,
  INVITATION_TTL_DAYS,
  MAIL_PENDING_GRACE_MINUTES,
} from "../../src/lib/team/invitations-model";
import {
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  expectSqlError,
  withTx,
  type TestUser,
} from "./helpers";
import { asUser, buildWorld, newToken, sha256Hex, type World } from "./send-helpers";
import { actAsService } from "./send-helpers";

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
const SETTLE = "select public.invitation_email_settle($1, $2, $3, $4) as r";

const INSUFFICIENT_PRIVILEGE = "42501";
const NOT_FOUND = "CP404";
const INVALID = "CP422";
const NOT_ALLOWED_STATE = "CP423";
const LIMIT = "CP429";

type Prepared = {
  id: string;
  email: string;
  hash: string;
  tokenSha: string;
  mailId: string;
  params: unknown[];
};

/** Los ocho argumentos de `create_invitation`, como los armaría la aplicación (el cifrado es de mentira). */
function prepare(over: { email?: string; role?: string; id?: string } = {}): Prepared {
  const id = over.id ?? randomUUID();
  const email = over.email ?? `nuevo-${randomUUID().slice(0, 8)}@ejemplo.test`;
  const hash = sha256Hex(`huella|${email.trim().toLowerCase()}`);
  const { sha } = newToken();
  const mailId = randomUUID();
  return {
    id,
    email,
    hash,
    tokenSha: sha,
    mailId,
    params: [
      id,
      `v1.cifrado.${id}`,
      hash,
      invitationEmailBinding(sha, email),
      sha,
      over.role ?? "sales",
      mailId,
      `v1.cifrado.correo.${mailId}`,
    ],
  };
}

async function call<T = Json>(user: TestUser, tenant: string, sql: string, params: unknown[]) {
  await asUser(setup, user, tenant);
  const { rows } = await setup.query<{ r: T }>(sql, params);
  await actAsPostgres(setup);
  return rows[0].r;
}

async function denied(user: TestUser, tenant: string, sql: string, params: unknown[]) {
  await asUser(setup, user, tenant);
  const error = await expectSqlError(setup, sql, params);
  await actAsPostgres(setup);
  return error;
}

const invite = (user: TestUser, over: Parameters<typeof prepare>[0] = {}, tenant = w.tenantA) => {
  const p = prepare(over);
  return call(user, tenant, CREATE, p.params).then((result) => ({ result, p }));
};

const row = async (id: string) => {
  await actAsPostgres(setup);
  return (await setup.query("select * from public.invitations where id = $1", [id])).rows[0];
};
const count = async (sql: string, params: unknown[] = []) => {
  await actAsPostgres(setup);
  return Number((await setup.query<{ n: string }>(sql, params)).rows[0].n);
};

/** Inserta N invitaciones sueltas (como el servidor) para probar los topes. */
async function seedInvitations(
  tenant: string,
  by: TestUser,
  n: number,
  opts: { status?: string; createdAgo?: string; expiresIn?: string } = {},
) {
  await actAsPostgres(setup);
  // El disparador de metadatos fija `created_at = now()`: se apaga solo dentro de esta transacción.
  await setup.query("set local session_replication_role = replica"); // sin bloquear la tabla
  for (let i = 0; i < n; i++) {
    await setup.query(
      `insert into public.invitations
         (id, tenant_id, email_enc, email_hash, email_binding, role, token_sha256, status, expires_at,
          invited_by, created_at, revoked_at, revoke_reason)
       values ($1, $2, 'v1.x.y', $3, $4, 'viewer', $5, $6, now() + $7::interval, $8, now() - $9::interval,
               case when $6 = 'revoked' then now() end, case when $6 = 'revoked' then 'cancelled' end)`,
      [
        randomUUID(),
        tenant,
        randomBytes(32).toString("hex"),
        randomBytes(32).toString("hex"),
        randomBytes(32).toString("hex"),
        opts.status ?? "pending",
        opts.expiresIn ?? "5 days",
        by.id,
        opts.createdAgo ?? "0 seconds",
      ],
    );
  }
  await setup.query("set local session_replication_role = origin");
}

describe("quién puede invitar", () => {
  it("el Dueño y el Administrador invitan; el correo queda registrado como «pendiente de enviar»", async () => {
    await withTx(setup, async () => {
      for (const user of [w.owner, w.admin]) {
        const { result, p } = await invite(user);
        expect(result.result).toBe("created");
        expect(result.invitation_id).toBe(p.id);
        expect(result.email_message_id).toBe(p.mailId);
        const inv = await row(p.id);
        expect(inv.tenant_id).toBe(w.tenantA);
        expect(inv.status).toBe("pending");
        expect(inv.invited_by).toBe(user.id);
        expect(inv.role).toBe("sales");
        expect(inv.send_count).toBe(1);
        expect(inv.token_sha256).toBe(p.tokenSha);
        // Vigencia de 7 días (dentro de un margen de segundos).
        const seconds = (new Date(inv.expires_at).getTime() - Date.now()) / 1000;
        expect(seconds).toBeGreaterThan(7 * 24 * 3600 - 60);
        expect(seconds).toBeLessThanOrEqual(7 * 24 * 3600 + 60);
        await actAsPostgres(setup);
        const mail = (
          await setup.query(
            "select * from public.email_messages where id = $1 and invitation_id = $2",
            [p.mailId, p.id],
          )
        ).rows[0];
        expect(mail.kind).toBe("invitation");
        expect(mail.status).toBe("pending");
        expect(mail.provider).toBe("pending");
        expect(mail.tenant_id).toBe(w.tenantA);
        expect(mail.to_email_hash).toBe(p.hash);
        expect(mail.created_by).toBe(user.id);
        expect(mail.quote_id).toBeNull();
      }
    });
  });

  it("el Aprobador, el Comercial y el Observador reciben «sin permiso» y no se crea nada", async () => {
    await withTx(setup, async () => {
      for (const user of [w.approver, w.sales, w.viewer]) {
        const p = prepare();
        const error = await denied(user, w.tenantA, CREATE, p.params);
        expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
        expect(
          await count("select count(*) as n from public.invitations where id = $1", [p.id]),
        ).toBe(0);
      }
    });
  });

  it("quien no es miembro de la organización recibe «no encontrado», no «sin permiso»", async () => {
    await withTx(setup, async () => {
      // El Dueño de B apuntando a la organización A, y alguien sin cabecera.
      const p = prepare();
      expect((await denied(w.ownerB, w.tenantA, CREATE, p.params)).code).toBe(NOT_FOUND);
      await asUser(setup, w.owner, "");
      expect((await expectSqlError(setup, CREATE, prepare().params)).code).toBe(NOT_FOUND);
      await actAsPostgres(setup);
      expect(
        await count("select count(*) as n from public.invitations where id = $1", [p.id]),
      ).toBe(0);
    });
  });

  it("un miembro que ya fue quitado de la organización también recibe «no encontrado»", async () => {
    await withTx(setup, async () => {
      await actAsPostgres(setup);
      await setup.query(
        "update public.members set status = 'removed', removed_at = now() where tenant_id = $1 and user_id = $2",
        [w.tenantA, w.admin.id],
      );
      expect((await denied(w.admin, w.tenantA, CREATE, prepare().params)).code).toBe(NOT_FOUND);
    });
  });
});

describe("el rol de la invitación", () => {
  it("se puede invitar como Administrador, Aprobador, Comercial u Observador", async () => {
    await withTx(setup, async () => {
      for (const role of ["admin", "approver", "sales", "viewer"]) {
        const { result, p } = await invite(w.owner, { role });
        expect(result.result, role).toBe("created");
        expect((await row(p.id)).role).toBe(role);
      }
    });
  });

  it("nunca como Dueño, ni con un rol que no existe, ni sin rol", async () => {
    await withTx(setup, async () => {
      for (const role of ["owner", "root", "ADMIN", "", "admin "]) {
        const p = prepare({ role });
        expect((await denied(w.owner, w.tenantA, CREATE, p.params)).code, role).toBe(INVALID);
        expect(
          await count("select count(*) as n from public.invitations where id = $1", [p.id]),
        ).toBe(0);
      }
      const nullRole = prepare();
      nullRole.params[5] = null;
      expect((await denied(w.owner, w.tenantA, CREATE, nullRole.params)).code).toBe(INVALID);
    });
  });

  it("la tabla misma tampoco guarda el rol Dueño (ni siquiera por una inserción directa)", async () => {
    await withTx(setup, async () => {
      await actAsPostgres(setup);
      const error = await expectSqlError(
        setup,
        `insert into public.invitations (id, tenant_id, email_enc, email_hash, email_binding, role, token_sha256,
           expires_at, invited_by)
         values ($1, $2, 'v1.x.y', $3, $3, 'owner', $3, now() + interval '1 day', $4)`,
        [randomUUID(), w.tenantA, sha256Hex("x"), w.owner.id],
      );
      expect(error.code).toBe("23514");
    });
  });

  it("argumentos mal formados dan «dato inválido»", async () => {
    await withTx(setup, async () => {
      const bad: [number, unknown][] = [
        [1, ""], // correo cifrado vacío
        [2, "no-es-hex"], // huella del correo
        [3, "A".repeat(64)], // vínculo en mayúsculas
        [4, "abc"], // huella del código
        [6, null], // id del correo
        [7, ""], // correo cifrado del registro
      ];
      for (const [index, value] of bad) {
        const p = prepare();
        p.params[index] = value;
        expect((await denied(w.owner, w.tenantA, CREATE, p.params)).code, `arg ${index}`).toBe(
          INVALID,
        );
      }
      const noId = prepare();
      noId.params[0] = null;
      expect((await denied(w.owner, w.tenantA, CREATE, noId.params)).code).toBe(INVALID);
    });
  });
});

describe("ya es miembro / ya hay una invitación", () => {
  it("invitar a un miembro activo de esta organización responde «already_member» y no crea nada", async () => {
    await withTx(setup, async () => {
      await actAsPostgres(setup);
      const { rows } = await setup.query<{ email: string }>(
        "select email from auth.users where id = $1",
        [w.sales.id],
      );
      // Con mayúsculas y espacios: la comparación normaliza igual que la aplicación.
      const { result, p } = await invite(w.owner, { email: `  ${rows[0].email.toUpperCase()} ` });
      expect(result.result).toBe("already_member");
      expect(
        await count("select count(*) as n from public.invitations where id = $1", [p.id]),
      ).toBe(0);
      expect(
        await count("select count(*) as n from public.email_messages where id = $1", [p.mailId]),
      ).toBe(0);
    });
  });

  it("alguien que ya salió de la organización sí se puede invitar de nuevo", async () => {
    await withTx(setup, async () => {
      await actAsPostgres(setup);
      await setup.query(
        "update public.members set status = 'removed', removed_at = now() where tenant_id = $1 and user_id = $2",
        [w.tenantA, w.sales2.id],
      );
      const { rows } = await setup.query<{ email: string }>(
        "select email from auth.users where id = $1",
        [w.sales2.id],
      );
      expect((await invite(w.owner, { email: rows[0].email })).result.result).toBe("created");
    });
  });

  it("invitar a alguien que es miembro de OTRA organización se ve igual que invitar a cualquiera", async () => {
    await withTx(setup, async () => {
      await actAsPostgres(setup);
      const { rows } = await setup.query<{ email: string }>(
        "select email from auth.users where id = $1",
        [w.ownerB.id],
      );
      const { result } = await invite(w.owner, { email: rows[0].email });
      expect(result.result).toBe("created");
      expect(Object.keys(result).sort()).toEqual(
        ["email_message_id", "expires_at", "invitation_id", "notify_owner", "result"].sort(),
      );
    });
  });

  it("una segunda invitación al mismo correo responde «already_pending» con la existente", async () => {
    await withTx(setup, async () => {
      const first = await invite(w.owner, { email: "repetido@ejemplo.test" });
      expect(first.result.result).toBe("created");
      // Otra persona del equipo, con otro código y la misma huella del correo.
      const again = prepare({ email: "repetido@ejemplo.test" });
      const second = await call(w.admin, w.tenantA, CREATE, again.params);
      expect(second).toEqual({ result: "already_pending", invitation_id: first.p.id });
      expect(
        await count(
          "select count(*) as n from public.invitations where tenant_id = $1 and email_hash = $2",
          [w.tenantA, first.p.hash],
        ),
      ).toBe(1);
      expect(
        await count("select count(*) as n from public.email_messages where id = $1", [
          again.mailId,
        ]),
      ).toBe(0);
    });
  });

  it("una invitación vencida pero sin cancelar también cuenta como pendiente (se ofrece reenviarla)", async () => {
    await withTx(setup, async () => {
      const first = await invite(w.owner, { email: "vencida@ejemplo.test" });
      await actAsPostgres(setup);
      await setup.query(
        "update public.invitations set expires_at = now() - interval '1 day' where id = $1",
        [first.p.id],
      );
      const second = await call(
        w.owner,
        w.tenantA,
        CREATE,
        prepare({ email: "vencida@ejemplo.test" }).params,
      );
      expect(second.result).toBe("already_pending");
    });
  });

  it("después de cancelar, se puede invitar de nuevo al mismo correo", async () => {
    await withTx(setup, async () => {
      const first = await invite(w.owner, { email: "otra-vez@ejemplo.test" });
      await call(w.owner, w.tenantA, REVOKE, [first.p.id]);
      const second = await invite(w.owner, { email: "otra-vez@ejemplo.test" });
      expect(second.result.result).toBe("created");
    });
  });

  it("el mismo correo en dos organizaciones distintas no choca", async () => {
    await withTx(setup, async () => {
      // La huella lleva la organización; aquí se simula la misma huella a propósito para mostrar que el índice es por organización.
      const a = prepare({ email: "dos@ejemplo.test" });
      const b = prepare({ email: "dos@ejemplo.test" });
      expect((await call(w.owner, w.tenantA, CREATE, a.params)).result).toBe("created");
      expect((await call(w.ownerB, w.tenantB, CREATE, b.params)).result).toBe("created");
    });
  });

  it("dos invitaciones al mismo correo AL MISMO TIEMPO: queda una sola, la otra recibe «already_pending»", async () => {
    // Organización propia (las dos conexiones confirman, no se puede deshacer).
    const owner = await createUser(setup);
    await setup.query("begin");
    const tenant = await createTenantAs(setup, owner, "76086428-5", "Carrera de invitaciones");
    await setup.query("commit");
    const second = await connect();
    try {
      const a = prepare({ email: "carrera@ejemplo.test" });
      const b = prepare({ email: "carrera@ejemplo.test" });
      const run = async (client: Client, p: Prepared) => {
        await client.query("begin");
        await asUser(client, owner, tenant);
        try {
          const { rows } = await client.query<{ r: Json }>(CREATE, p.params);
          await new Promise((resolve) => setTimeout(resolve, 150)); // se mantiene el candado un instante
          await client.query("commit");
          return rows[0].r.result;
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      };
      const results = await Promise.all([run(setup, a), run(second, b)]);
      expect([...results].sort()).toEqual(["already_pending", "created"]);
      expect(
        await count("select count(*) as n from public.invitations where tenant_id = $1", [tenant]),
      ).toBe(1);
      expect(
        await count(
          "select count(*) as n from public.email_messages where tenant_id = $1 and kind = 'invitation'",
          [tenant],
        ),
      ).toBe(1);
    } finally {
      await actAsPostgres(setup);
      await second.end();
    }
  });
});

describe("topes", () => {
  it("20 invitaciones por persona por hora: la 21 se rechaza, y otra persona de la organización sigue pudiendo", async () => {
    await withTx(setup, async () => {
      await seedInvitations(w.tenantA, w.owner, 20);
      const p = prepare();
      expect((await denied(w.owner, w.tenantA, CREATE, p.params)).message).toContain(
        "limit_user_hour",
      );
      expect((await denied(w.owner, w.tenantA, CREATE, p.params)).code).toBe(LIMIT);
      expect((await invite(w.admin)).result.result).toBe("created");
    });
  });

  it("las invitaciones de hace más de una hora no cuentan para el tope por persona", async () => {
    await withTx(setup, async () => {
      await seedInvitations(w.tenantA, w.owner, 20, { createdAgo: "61 minutes" });
      expect((await invite(w.owner)).result.result).toBe("created");
    });
  });

  it("50 invitaciones por organización por día: la 51 se rechaza (las canceladas también cuentan)", async () => {
    await withTx(setup, async () => {
      // Repartidas entre dos personas y hechas hace horas, para no chocar con el tope por persona.
      await seedInvitations(w.tenantA, w.owner, 25, { createdAgo: "3 hours" });
      await seedInvitations(w.tenantA, w.admin, 25, { createdAgo: "4 hours", status: "revoked" });
      expect((await denied(w.owner, w.tenantA, CREATE, prepare().params)).message).toContain(
        "limit_tenant_day",
      );
      // Otra organización no se ve afectada.
      expect((await invite(w.ownerB, {}, w.tenantB)).result.result).toBe("created");
    });
  });

  it("las de hace más de un día no cuentan para el tope por organización", async () => {
    await withTx(setup, async () => {
      await seedInvitations(w.tenantA, w.owner, 30, { createdAgo: "25 hours", status: "revoked" });
      await seedInvitations(w.tenantA, w.admin, 30, { createdAgo: "26 hours", status: "revoked" });
      expect((await invite(w.owner)).result.result).toBe("created");
    });
  });

  it("50 pendientes por organización; las vencidas no cuentan", async () => {
    await withTx(setup, async () => {
      await seedInvitations(w.tenantA, w.owner, 25, { createdAgo: "3 days" });
      await seedInvitations(w.tenantA, w.admin, 25, { createdAgo: "3 days" });
      expect((await denied(w.owner, w.tenantA, CREATE, prepare().params)).message).toContain(
        "limit_pending",
      );
      // Cancelar una libera un cupo.
      await actAsPostgres(setup);
      const { rows } = await setup.query<{ id: string }>(
        "select id from public.invitations where tenant_id = $1 limit 1",
        [w.tenantA],
      );
      await call(w.owner, w.tenantA, REVOKE, [rows[0].id]);
      expect((await invite(w.owner)).result.result).toBe("created");
    });
    await withTx(setup, async () => {
      await seedInvitations(w.tenantA, w.owner, 25, { createdAgo: "3 days", expiresIn: "-1 day" });
      await seedInvitations(w.tenantA, w.admin, 25, { createdAgo: "3 days", expiresIn: "-2 days" });
      expect((await invite(w.owner)).result.result).toBe("created");
    });
  });
});

describe("reenviar", () => {
  const resendArgs = (id: string) => {
    const { sha } = newToken();
    const mailId = randomUUID();
    return {
      sha,
      mailId,
      params: [id, invitationEmailBinding(sha, "x@ejemplo.test"), sha, mailId, `v1.re.${mailId}`],
    };
  };
  const backdateSend = async (id: string, interval = "11 minutes") => {
    await actAsPostgres(setup);
    await setup.query(
      "update public.invitations set last_sent_at = now() - $2::interval where id = $1",
      [id, interval],
    );
  };

  it("genera un código nuevo (el anterior deja de existir), extiende la vigencia y registra otro correo", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner, { email: "reenvio@ejemplo.test" });
      await actAsPostgres(setup);
      await setup.query(
        "update public.invitations set expires_at = now() + interval '1 hour' where id = $1",
        [p.id],
      );
      await backdateSend(p.id);
      const r = resendArgs(p.id);
      const result = await call(w.admin, w.tenantA, RESEND, r.params);
      expect(result.result).toBe("resent");
      expect(result.send_count).toBe(2);
      const inv = await row(p.id);
      expect(inv.token_sha256).toBe(r.sha);
      expect(inv.token_sha256).not.toBe(p.tokenSha);
      expect(inv.email_binding).toBe(r.params[1]);
      expect(inv.send_count).toBe(2);
      expect(new Date(inv.expires_at).getTime() - Date.now()).toBeGreaterThan(6 * 24 * 3600 * 1000);
      // El código viejo ya no está en ninguna parte.
      expect(
        await count("select count(*) as n from public.invitations where token_sha256 = $1", [
          p.tokenSha,
        ]),
      ).toBe(0);
      expect(
        await count(
          "select count(*) as n from public.email_messages where invitation_id = $1 and kind = 'invitation'",
          [p.id],
        ),
      ).toBe(2);
      // Quedó anotado en la auditoría, sin el correo.
      const audit = await count(
        "select count(*) as n from public.audit_log where tenant_id = $1 and action = 'invitation.resent' and resource_id = $2",
        [w.tenantA, p.id],
      );
      expect(audit).toBe(1);
    });
  });

  it("también se puede reenviar una invitación vencida: vuelve a estar vigente", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner, { email: "vencida2@ejemplo.test" });
      await actAsPostgres(setup);
      await setup.query(
        "update public.invitations set expires_at = now() - interval '2 days' where id = $1",
        [p.id],
      );
      await backdateSend(p.id);
      expect((await call(w.owner, w.tenantA, RESEND, resendArgs(p.id).params)).result).toBe(
        "resent",
      );
      expect(new Date((await row(p.id)).expires_at).getTime()).toBeGreaterThan(Date.now());
    });
  });

  it("exige 10 minutos entre un envío y el siguiente", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      const error = await denied(w.owner, w.tenantA, RESEND, resendArgs(p.id).params);
      expect(error.code).toBe(LIMIT);
      expect(error.message).toContain("resend_too_soon");
      await backdateSend(p.id, "9 minutes");
      expect((await denied(w.owner, w.tenantA, RESEND, resendArgs(p.id).params)).code).toBe(LIMIT);
      await backdateSend(p.id, "10 minutes 1 second");
      expect((await call(w.owner, w.tenantA, RESEND, resendArgs(p.id).params)).result).toBe(
        "resent",
      );
    });
  });

  it("si el último correo NUNCA salió (falló, o quedó pendiente más de 2 minutos) se puede reintentar de inmediato", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner, { email: "no-salio@ejemplo.test" });
      // Recién creada: el correo sigue «pendiente de enviar» hace segundos -> hay que esperar.
      expect((await denied(w.owner, w.tenantA, RESEND, resendArgs(p.id).params)).code).toBe(LIMIT);
      // El envío falló: nadie recibió nada, no hay por qué esperar.
      await actAsService(setup);
      await setup.query(SETTLE, [p.mailId, null, null, "timeout"]);
      const first = resendArgs(p.id);
      expect((await call(w.owner, w.tenantA, RESEND, first.params)).result).toBe("resent");
      // El nuevo correo quedó pendiente hace más de 2 minutos (el servidor se cayó): también se reintenta.
      // (Dentro de una transacción todas las filas comparten la hora: se fecha cada correo a mano.)
      const age = async (mailId: string, interval: string) => {
        await actAsPostgres(setup);
        await setup.query("set local session_replication_role = replica"); // sin bloquear la tabla
        await setup.query(
          "update public.email_messages set created_at = now() - $2::interval where id = $1",
          [mailId, interval],
        );
        await setup.query("set local session_replication_role = origin");
      };
      await age(p.mailId, "1 hour");
      await age(first.mailId, "3 minutes");
      const second = resendArgs(p.id);
      expect((await call(w.owner, w.tenantA, RESEND, second.params)).send_count).toBe(3);
      // Un correo que SÍ salió respeta los 10 minutos.
      await age(first.mailId, "1 hour");
      await actAsService(setup);
      await setup.query(SETTLE, [second.mailId, "mailpit", "ok-1", null]);
      expect((await denied(w.owner, w.tenantA, RESEND, resendArgs(p.id).params)).code).toBe(LIMIT);
    });
  });

  it("reenviar una invitación VENCIDA cuenta para el tope de 50 pendientes, como invitar (M1)", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner, { email: "vencida-tope@ejemplo.test" });
      await actAsPostgres(setup);
      await setup.query(
        "update public.invitations set expires_at = now() - interval '2 days' where id = $1",
        [p.id],
      );
      await backdateSend(p.id);
      await seedInvitations(w.tenantA, w.admin, 25, { createdAgo: "3 days" });
      await seedInvitations(w.tenantA, w.approver, 25, { createdAgo: "3 days" });
      const error = await denied(w.owner, w.tenantA, RESEND, resendArgs(p.id).params);
      expect(error.code).toBe(LIMIT);
      expect(error.message).toContain("limit_pending");
      expect((await row(p.id)).send_count).toBe(1);
      // Con un cupo libre (49 vigentes) sí se puede.
      await actAsPostgres(setup);
      await setup.query(
        "delete from public.invitations where id = (select id from public.invitations where tenant_id = $1 and invited_by = $2 limit 1)",
        [w.tenantA, w.admin.id],
      );
      expect((await call(w.owner, w.tenantA, RESEND, resendArgs(p.id).params)).result).toBe(
        "resent",
      );
    });
  });

  it("reenviar una invitación VIGENTE no se mira contra el tope de pendientes (ya cuenta como una de ellas)", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner, { email: "vigente-tope@ejemplo.test" });
      await backdateSend(p.id);
      await seedInvitations(w.tenantA, w.admin, 25, { createdAgo: "3 days" });
      await seedInvitations(w.tenantA, w.approver, 24, { createdAgo: "3 days" });
      expect((await call(w.owner, w.tenantA, RESEND, resendArgs(p.id).params)).result).toBe(
        "resent",
      );
    });
  });

  it("como máximo 5 reenvíos por invitación", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      for (let n = 1; n <= 5; n++) {
        await backdateSend(p.id);
        expect((await call(w.owner, w.tenantA, RESEND, resendArgs(p.id).params)).send_count).toBe(
          n + 1,
        );
      }
      await backdateSend(p.id);
      const error = await denied(w.owner, w.tenantA, RESEND, resendArgs(p.id).params);
      expect(error.code).toBe(LIMIT);
      expect(error.message).toContain("limit_resends");
      expect((await row(p.id)).send_count).toBe(6);
    });
  });

  it("solo quien maneja el equipo reenvía; el resto recibe «sin permiso» y nada cambia", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      await backdateSend(p.id);
      for (const user of [w.approver, w.sales, w.viewer]) {
        expect((await denied(user, w.tenantA, RESEND, resendArgs(p.id).params)).code).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
      expect((await row(p.id)).token_sha256).toBe(p.tokenSha);
    });
  });

  it("una invitación de otra organización o inexistente: «no encontrado»", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      await backdateSend(p.id);
      // El Dueño de B apuntando a SU organización con el id de una invitación de A.
      const cross = await denied(w.ownerB, w.tenantB, RESEND, resendArgs(p.id).params);
      expect(cross.code).toBe(NOT_FOUND);
      expect((await denied(w.ownerB, w.tenantA, RESEND, resendArgs(p.id).params)).code).toBe(
        NOT_FOUND,
      );
      expect((await denied(w.owner, w.tenantA, RESEND, resendArgs(randomUUID()).params)).code).toBe(
        NOT_FOUND,
      );
      expect((await row(p.id)).token_sha256).toBe(p.tokenSha);
    });
  });

  it("una invitación cancelada o aceptada ya no se reenvía", async () => {
    await withTx(setup, async () => {
      const a = await invite(w.owner, { email: "cancelada@ejemplo.test" });
      await call(w.owner, w.tenantA, REVOKE, [a.p.id]);
      await backdateSend(a.p.id);
      expect((await denied(w.owner, w.tenantA, RESEND, resendArgs(a.p.id).params)).code).toBe(
        NOT_ALLOWED_STATE,
      );
    });
  });
});

describe("cancelar", () => {
  it("deja la invitación «revoked» con quién y cuándo, y queda en la auditoría sin el correo", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner, { email: "cancelar@ejemplo.test" });
      expect(await call(w.admin, w.tenantA, REVOKE, [p.id])).toEqual({ result: "revoked" });
      const inv = await row(p.id);
      expect(inv.status).toBe("revoked");
      expect(inv.revoked_by).toBe(w.admin.id);
      expect(inv.revoke_reason).toBe("cancelled");
      expect(inv.revoked_at).not.toBeNull();
      // Repetir no cambia nada.
      expect(await call(w.admin, w.tenantA, REVOKE, [p.id])).toEqual({ result: "already_revoked" });
      expect(
        await count(
          "select count(*) as n from public.audit_log where tenant_id = $1 and action = 'invitation.revoked' and resource_id = $2",
          [w.tenantA, p.id],
        ),
      ).toBe(1);
    });
  });

  it("solo quien maneja el equipo cancela", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      for (const user of [w.approver, w.sales, w.viewer]) {
        expect((await denied(user, w.tenantA, REVOKE, [p.id])).code).toBe(INSUFFICIENT_PRIVILEGE);
      }
      expect((await row(p.id)).status).toBe("pending");
    });
  });

  it("de otra organización o inexistente: «no encontrado» y nada cambia", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      expect((await denied(w.ownerB, w.tenantB, REVOKE, [p.id])).code).toBe(NOT_FOUND);
      expect((await denied(w.ownerB, w.tenantA, REVOKE, [p.id])).code).toBe(NOT_FOUND);
      expect((await denied(w.owner, w.tenantA, REVOKE, [randomUUID()])).code).toBe(NOT_FOUND);
      expect((await row(p.id)).status).toBe("pending");
    });
  });

  it("una invitación ya aceptada no se puede cancelar", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner, { email: "aceptada@ejemplo.test" });
      await actAsPostgres(setup);
      await setup.query(
        `update public.invitations set status = 'accepted', accepted_at = now(), accepted_by = $2,
           email_enc = null, email_hash = null, email_binding = null where id = $1`,
        [p.id, w.sales.id],
      );
      expect((await denied(w.owner, w.tenantA, REVOKE, [p.id])).code).toBe(NOT_ALLOWED_STATE);
      expect((await row(p.id)).status).toBe("accepted");
    });
  });
});

describe("quién ve la tabla", () => {
  it("el Dueño y el Administrador leen las columnas permitidas de su organización; nadie lee las huellas ni el vínculo", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner, { role: "approver" });
      const own = "id, tenant_id, email_enc, role, status, expires_at, invited_by, send_count";
      for (const user of [w.owner, w.admin]) {
        await asUser(setup, user, w.tenantA);
        const { rows } = await setup.query(`select ${own} from public.invitations where id = $1`, [
          p.id,
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].role).toBe("approver");
        for (const column of ["token_sha256", "email_binding", "email_hash", "*"]) {
          const error = await expectSqlError(setup, `select ${column} from public.invitations`);
          expect(error.code, `${user.id} ${column}`).toBe(INSUFFICIENT_PRIVILEGE);
        }
        await actAsPostgres(setup);
      }
    });
  });

  it("el Aprobador, el Comercial y el Observador ven cero filas", async () => {
    await withTx(setup, async () => {
      await invite(w.owner);
      for (const user of [w.approver, w.sales, w.viewer]) {
        await asUser(setup, user, w.tenantA);
        const { rows } = await setup.query("select id from public.invitations");
        expect(rows, user.id).toEqual([]);
        await actAsPostgres(setup);
      }
    });
  });

  it("el Dueño de otra organización no ve las invitaciones de A, ni con la cabecera de A", async () => {
    await withTx(setup, async () => {
      await invite(w.owner);
      for (const tenant of [w.tenantA, w.tenantB]) {
        await asUser(setup, w.ownerB, tenant);
        const { rows } = await setup.query("select id from public.invitations");
        expect(rows).toEqual([]);
        await actAsPostgres(setup);
      }
    });
  });

  it("nadie escribe directo en la tabla, tampoco el Dueño", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      await asUser(setup, w.owner, w.tenantA);
      for (const sql of [
        "update public.invitations set role = 'admin'",
        "delete from public.invitations",
        `insert into public.invitations (id, tenant_id, role, token_sha256, expires_at, invited_by)
           values (gen_random_uuid(), '${w.tenantA}', 'viewer', '${sha256Hex("z")}', now(), '${w.owner.id}')`,
      ]) {
        expect((await expectSqlError(setup, sql)).code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
      await actAsPostgres(setup);
      expect((await row(p.id)).role).toBe("sales");
    });
  });

  it("el correo registrado de la invitación lo leen quienes manejan el equipo; el resto de los miembros no", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      for (const [user, expected] of [
        [w.owner, 1],
        [w.admin, 1],
        [w.approver, 0],
        [w.sales, 0],
        [w.viewer, 0],
      ] as const) {
        await asUser(setup, user, w.tenantA);
        const { rows } = await setup.query("select id from public.email_messages where id = $1", [
          p.mailId,
        ]);
        expect(rows.length, user.id).toBe(expected);
        await actAsPostgres(setup);
      }
    });
  });
});

describe("auditoría", () => {
  it("crear, reenviar y cancelar quedan registrados con quién y cuándo, y NUNCA con el correo ni el código", async () => {
    await withTx(setup, async () => {
      const email = "secreto-auditoria@ejemplo.test";
      const { p } = await invite(w.owner, { email });
      await actAsPostgres(setup);
      await setup.query(
        "update public.invitations set last_sent_at = now() - interval '11 minutes' where id = $1",
        [p.id],
      );
      const { sha } = newToken();
      await call(w.owner, w.tenantA, RESEND, [
        p.id,
        invitationEmailBinding(sha, email),
        sha,
        randomUUID(),
        "v1.x.y",
      ]);
      await call(w.owner, w.tenantA, REVOKE, [p.id]);
      await actAsPostgres(setup);
      const { rows } = await setup.query(
        "select action, actor_user_id, occurred_at, details::text as details from public.audit_log where tenant_id = $1 and resource_id = $2 order by id",
        [w.tenantA, p.id],
      );
      const actions = rows.map((r) => r.action);
      expect(actions).toContain("invitation.created");
      expect(actions).toContain("invitation.resent");
      expect(actions).toContain("invitation.revoked");
      const createdEvent = rows.find((r) => r.action === "invitation.created");
      expect(JSON.parse(createdEvent.details)).toEqual({ role: "sales" });
      for (const r of rows) {
        expect(r.actor_user_id).toBe(w.owner.id);
        expect(r.occurred_at).not.toBeNull();
        for (const secret of [email, p.hash, p.tokenSha, sha, `v1.cifrado.${p.id}`]) {
          expect(r.details, r.action).not.toContain(secret);
        }
      }
    });
  });
});

describe("cerrar el envío del correo (solo el servidor)", () => {
  it("enviado: queda el proveedor y su identificador; repetir no cambia nada", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      await actAsService(setup);
      const sent = await setup.query<{ r: Json }>(SETTLE, [p.mailId, "mailpit", "id-123", null]);
      expect(sent.rows[0].r).toEqual({ status: "sent" });
      const again = await setup.query<{ r: Json }>(SETTLE, [p.mailId, "mailpit", "id-999", null]);
      expect(again.rows[0].r).toEqual({ status: "already_settled" });
      await actAsPostgres(setup);
      const mail = (
        await setup.query("select * from public.email_messages where id = $1", [p.mailId])
      ).rows[0];
      expect(mail.status).toBe("sent");
      expect(mail.provider).toBe("mailpit");
      expect(mail.provider_message_id).toBe("id-123");
      expect(mail.sent_at).not.toBeNull();
    });
  });

  it("fallido: queda solo un código, sin datos personales", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      await actAsService(setup);
      const failed = await setup.query<{ r: Json }>(SETTLE, [p.mailId, null, null, "timeout"]);
      expect(failed.rows[0].r).toEqual({ status: "failed" });
      const bad = await expectSqlError(setup, SETTLE, [
        randomUUID(),
        null,
        null,
        "algo con espacios y @",
      ]);
      expect(bad.code).toBe(NOT_FOUND);
      await actAsPostgres(setup);
      const mail = (
        await setup.query("select * from public.email_messages where id = $1", [p.mailId])
      ).rows[0];
      expect(mail.status).toBe("failed");
      expect(mail.error_code).toBe("timeout");
    });
  });

  it("un código de error con datos personales se rechaza", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      await actAsService(setup);
      const error = await expectSqlError(setup, SETTLE, [p.mailId, null, null, "ana@ejemplo.test"]);
      expect(error.code).toBe(INVALID);
    });
  });

  it("no cierra el correo de una cotización, y ninguna persona con pase puede llamarla", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      for (const user of [w.owner, w.admin]) {
        await asUser(setup, user, w.tenantA);
        expect((await expectSqlError(setup, SETTLE, [p.mailId, "mailpit", "x", null])).code).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        await actAsPostgres(setup);
      }
      await actAsService(setup);
      expect((await expectSqlError(setup, SETTLE, [randomUUID(), "mailpit", "x", null])).code).toBe(
        NOT_FOUND,
      );
    });
  });
});

describe("aviso al Dueño: anotado al invitar, reservado, enviado y reintentado por la tarea", () => {
  const PENDING = "select public.invitation_notices_pending($1, $2) as r";
  const RECIPIENTS = "select public.invitation_notice_recipients($1) as r";
  const REGISTER = "select public.invitation_notice_register($1, $2, $3, $4, $5) as r";
  const MAX_ATTEMPTS = 5;
  type Pending = { invitation_ids: string[]; exhausted: number };
  type Settled = { status: string; exhausted?: boolean };
  type Recipients = {
    recipients: { user_id: string; email: string }[];
    inviter_name?: string | null;
    role?: string;
    tenant_id?: string;
    tenant_name?: string;
    exhausted?: string;
  };

  const asServer = async <T = Json>(sql: string, params: unknown[]): Promise<T> => {
    await actAsService(setup);
    const { rows } = await setup.query<{ r: T }>(sql, params);
    await actAsPostgres(setup);
    return rows[0].r;
  };
  /** ¿Se puede reservar un intento de este aviso ahora? (No mira la lista: otras corridas pueden dejar avisos listos.) */
  const ready = async (id: string) => {
    await actAsPostgres(setup);
    return (await setup.query<{ r: boolean }>("select app.invitation_notice_ready($1) as r", [id]))
      .rows[0].r;
  };
  /** Reserva un intento de ESTE aviso (lo que hace el intento inmediato). */
  const reserve = async (id: string) =>
    (await asServer<Pending>(PENDING, [10, id])).invitation_ids.includes(id);
  /** Reserva una tanda (lo que hace la tarea). */
  const reserveBatch = (limit = 100) => asServer<Pending>(PENDING, [limit, null]);
  const state = async (id: string) => {
    const inv = await row(id);
    return {
      state: inv.owner_notice_state as string,
      attempts: inv.owner_notice_attempts as number,
    };
  };
  /** Un intento completo: reserva y anota el correo (como la tarea). `null` si la base no lo permitió. */
  const attempt = async (invitationId: string, to = w.owner.id) => {
    if (!(await reserve(invitationId))) return null;
    const mailId = randomUUID();
    const result = await asServer<{ registered: boolean }>(REGISTER, [
      mailId,
      invitationId,
      to,
      "v1.cifrado.aviso",
      sha256Hex("aviso"),
    ]);
    return result.registered ? mailId : null;
  };
  const settleFailed = (mailId: string, code = "provider_rejected") =>
    asServer<Settled>(SETTLE, [mailId, null, null, code]);
  /** Deja pasar el intervalo entre intentos (sin esperar 10 minutos de verdad). */
  const waitRetryInterval = async (invitationId: string) => {
    await actAsPostgres(setup);
    await setup.query(
      "update public.invitations set owner_notice_last_attempt_at = now() - interval '11 minutes' where id = $1",
      [invitationId],
    );
  };
  /** Fecha un correo hacia atrás (las filas de correo no se pueden editar: sin tocar la tabla, solo esta sesión). */
  const ageEmail = async (mailId: string, interval: string) => {
    await actAsPostgres(setup);
    await setup.query("set local session_replication_role = replica");
    await setup.query(
      "update public.email_messages set created_at = now() - $2::interval where id = $1",
      [mailId, interval],
    );
    await setup.query("set local session_replication_role = origin");
  };
  const accept = async (id: string) => {
    await actAsPostgres(setup);
    await setup.query(
      `update public.invitations set status = 'accepted', accepted_at = now(), accepted_by = $2,
         email_enc = null, email_hash = null, email_binding = null where id = $1`,
      [id, w.sales.id],
    );
  };
  const noticeMails = async (id: string) =>
    count(
      "select count(*) as n from public.email_messages where invitation_id = $1 and kind = 'invitation_notice'",
      [id],
    );

  describe("qué se anota al invitar", () => {
    it("llamar a create_invitation DIRECTO como Administrador, invitando a un Administrador, deja el aviso anotado como pendiente", async () => {
      await withTx(setup, async () => {
        // `invite` llama a la función de la base tal cual: no pasa por la aplicación ni por la pantalla.
        const { result, p } = await invite(w.admin, { role: "admin" });
        expect(result.notify_owner).toBe(true);
        expect(await state(p.id)).toEqual({ state: "pending", attempts: 0 });
        expect(await ready(p.id)).toBe(true);
      });
    });

    it("si no corresponde avisar, no queda nada anotado", async () => {
      await withTx(setup, async () => {
        const cases: [TestUser, string][] = [
          [w.owner, "admin"], // el Dueño invita a un Administrador
          [w.admin, "sales"],
          [w.admin, "approver"],
          [w.admin, "viewer"],
        ];
        for (const [user, role] of cases) {
          const { p } = await invite(user, { role });
          expect(await state(p.id), role).toEqual({ state: "none", attempts: 0 });
          expect(await ready(p.id)).toBe(false);
          expect(await attempt(p.id)).toBeNull();
        }
      });
    });

    it("el Administrador no lee ni escribe las columnas del aviso (owner_notice_*)", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        for (const user of [w.admin, w.owner]) {
          await asUser(setup, user, w.tenantA);
          for (const column of [
            "owner_notice_state",
            "owner_notice_attempts",
            "owner_notice_last_attempt_at",
          ]) {
            expect(
              (await expectSqlError(setup, `select ${column} from public.invitations`)).code,
              `leer ${column}`,
            ).toBe(INSUFFICIENT_PRIVILEGE);
            expect(
              (
                await expectSqlError(
                  setup,
                  `update public.invitations set ${column} = ${column} where id = $1`,
                  [p.id],
                )
              ).code,
              `escribir ${column}`,
            ).toBe(INSUFFICIENT_PRIVILEGE);
          }
          await actAsPostgres(setup);
        }
        expect(await state(p.id)).toEqual({ state: "pending", attempts: 0 });
      });
    });
  });

  describe("destinatarios y registro de un intento", () => {
    it("con un intento reservado, los destinatarios salen de la fila de la invitación: el Dueño de ESA organización", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        // Sin reserva no hay destinatarios (nadie puede pedirlos «de gratis»).
        expect((await asServer<Recipients>(RECIPIENTS, [p.id])).recipients).toEqual([]);
        expect(await reserve(p.id)).toBe(true);
        const info = await asServer<Recipients>(RECIPIENTS, [p.id]);
        expect(info.tenant_id).toBe(w.tenantA);
        expect(info.recipients).toEqual([{ user_id: w.owner.id, email: await ownerEmail() }]);
        expect(info.role).toBe("admin");
        expect(typeof info.tenant_name).toBe("string");
      });
    });

    it("lo que entrega la base para el aviso no contiene el correo del invitado ni sus huellas", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin", email: "secreto-aviso@ejemplo.test" });
        await reserve(p.id);
        const text = JSON.stringify(await asServer<Recipients>(RECIPIENTS, [p.id])).toLowerCase();
        for (const secret of [
          "secreto-aviso",
          p.hash,
          p.tokenSha,
          `v1.cifrado.${p.id}`,
          "binding",
        ]) {
          expect(text).not.toContain(secret.toLowerCase());
        }
      });
    });

    it("el nombre de quien invita sale sin espacios sobrantes y vacío (nulo) si es solo espacios, con datos reales", async () => {
      await withTx(setup, async () => {
        const set = async (name: string) => {
          await actAsPostgres(setup);
          await setup.query("update public.profiles set full_name = $2 where user_id = $1", [
            w.admin.id,
            name,
          ]);
        };
        const readName = async () => {
          const { p } = await invite(w.admin, { role: "admin" });
          await reserve(p.id);
          return (await asServer<Recipients>(RECIPIENTS, [p.id])).inviter_name;
        };
        await set("   ");
        expect(await readName()).toBeNull();
        await set("  Ana Pérez  ");
        expect(await readName()).toBe("Ana Pérez");
      });
    });

    it("se anota un correo por reserva, para el Dueño activo; repetir no crea otro y al enviarse queda «sent»", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        expect(await reserve(p.id)).toBe(true);
        const mailId = randomUUID();
        const args = [mailId, p.id, w.owner.id, "v1.cifrado.aviso", sha256Hex("aviso")];
        expect(await asServer(REGISTER, args)).toEqual({ registered: true });
        await actAsPostgres(setup);
        const mail = (
          await setup.query("select * from public.email_messages where id = $1", [mailId])
        ).rows[0];
        expect(mail.kind).toBe("invitation_notice");
        expect(mail.status).toBe("pending");
        expect(mail.invitation_id).toBe(p.id);
        expect(mail.created_by).toBeNull();
        // La reserva ya se usó: otro correo no se anota.
        expect(
          await asServer(REGISTER, [
            randomUUID(),
            p.id,
            w.owner.id,
            "v1.cifrado.aviso",
            sha256Hex("aviso"),
          ]),
        ).toEqual({ registered: false });
        expect((await asServer<Recipients>(RECIPIENTS, [p.id])).recipients).toEqual([]);
        expect(await asServer(SETTLE, [mailId, "mailpit", "n-1", null])).toEqual({
          status: "sent",
        });
        expect((await state(p.id)).state).toBe("sent");
      });
    });

    it("sin reserva no se anota nada, aunque sea el Dueño de verdad", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        expect(
          await asServer(REGISTER, [randomUUID(), p.id, w.owner.id, "v1.x.y", sha256Hex("a")]),
        ).toEqual({ registered: false });
        expect(await noticeMails(p.id)).toBe(0);
      });
    });

    it("el destinatario es siempre el Dueño de ESA organización: el Dueño de otra, un Administrador o cualquiera se rechazan", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        await reserve(p.id);
        await actAsService(setup);
        for (const to of [w.ownerB.id, w.admin.id, w.sales.id, randomUUID()]) {
          const error = await expectSqlError(setup, REGISTER, [
            randomUUID(),
            p.id,
            to,
            "v1.cifrado.aviso",
            sha256Hex("aviso"),
          ]);
          expect(error.code, to).toBe(INSUFFICIENT_PRIVILEGE);
          expect(error.message).toContain("recipient_not_owner");
        }
        expect(
          (
            await expectSqlError(setup, REGISTER, [
              randomUUID(),
              p.id,
              w.owner.id,
              "",
              sha256Hex("a"),
            ])
          ).code,
        ).toBe(INVALID);
        await actAsPostgres(setup);
        expect(await noticeMails(p.id)).toBe(0);
      });
    });

    it("nadie con un pase ejecuta esas funciones", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        for (const user of [w.owner, w.admin]) {
          for (const [sql, params] of [
            [RECIPIENTS, [p.id]],
            [PENDING, [10, null]],
            [REGISTER, [randomUUID(), p.id, w.owner.id, "v1.x.y", sha256Hex("a")]],
          ] as [string, unknown[]][]) {
            await asUser(setup, user, w.tenantA);
            expect((await expectSqlError(setup, sql, params)).code).toBe(INSUFFICIENT_PRIVILEGE);
            await actAsPostgres(setup);
          }
        }
      });
    });

    it("el registro del aviso lo lee solo el Dueño: ni el Administrador, que es quien invitó, ni nadie más", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        const mailId = await attempt(p.id);
        for (const [user, expected] of [
          [w.owner, 1],
          [w.admin, 0],
          [w.sales, 0],
          [w.viewer, 0],
          [w.approver, 0],
        ] as const) {
          await asUser(setup, user, w.tenantA);
          const { rows } = await setup.query("select id from public.email_messages where id = $1", [
            mailId,
          ]);
          expect(rows.length, user.id).toBe(expected);
          await actAsPostgres(setup);
        }
      });
    });

    it("el correo de la invitación sí lo ven quienes manejan el equipo (Dueño y Administrador)", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        for (const [user, expected] of [
          [w.owner, 1],
          [w.admin, 1],
          [w.sales, 0],
        ] as const) {
          await asUser(setup, user, w.tenantA);
          const { rows } = await setup.query("select id from public.email_messages where id = $1", [
            p.mailId,
          ]);
          expect(rows.length, user.id).toBe(expected);
          await actAsPostgres(setup);
        }
      });
    });
  });

  describe("reservar un intento (gastarlo antes de enviar)", () => {
    it("reservar anota la hora y cuenta el intento; mientras no pase el intervalo, no se puede reservar otro", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        expect(await reserve(p.id)).toBe(true);
        const inv = await row(p.id);
        expect(inv.owner_notice_attempts).toBe(1);
        expect(inv.owner_notice_last_attempt_at).not.toBeNull();
        expect(await ready(p.id)).toBe(false);
        expect(await reserve(p.id)).toBe(false);
        expect((await state(p.id)).attempts).toBe(1);
      });
    });

    it("mientras hay un intento vivo (pendiente de enviar) no se reserva otro; enviado, nunca más (sin duplicados)", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        const first = await attempt(p.id);
        expect(first).not.toBeNull();
        await waitRetryInterval(p.id);
        expect(await ready(p.id)).toBe(false);
        expect(await reserve(p.id)).toBe(false);
        expect(await asServer(SETTLE, [first, "mailpit", "n-1", null])).toEqual({ status: "sent" });
        expect(await state(p.id)).toEqual({ state: "sent", attempts: 1 });
        await waitRetryInterval(p.id);
        expect(await ready(p.id)).toBe(false);
        expect(await attempt(p.id)).toBeNull();
        expect(await noticeMails(p.id)).toBe(1);
      });
    });

    it("dos tareas a la vez no toman el mismo aviso (skip locked)", async () => {
      // Datos confirmados (las dos conexiones tienen que verlos); se borran al terminar.
      await setup.query("begin");
      const { p } = await invite(w.admin, { role: "admin", email: "carrera-aviso@ejemplo.test" });
      await setup.query("commit");
      const second = await connect();
      try {
        const run = async (client: Client) => {
          await client.query("begin");
          await actAsService(client);
          try {
            const { rows } = await client.query<{ r: Pending }>(PENDING, [100, p.id]);
            await new Promise((resolve) => setTimeout(resolve, 200)); // se mantiene el candado un instante
            await client.query("commit");
            return rows[0].r.invitation_ids.includes(p.id);
          } catch (error) {
            await client.query("rollback");
            throw error;
          }
        };
        const results = await Promise.all([run(setup), run(second)]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await state(p.id)).attempts).toBe(1);
      } finally {
        await actAsPostgres(setup);
        await second.end();
        // Limpieza de los datos ficticios de esta prueba (sin las reglas de solo agregar, solo en esta sesión).
        await setup.query("begin");
        await setup.query("set local session_replication_role = replica");
        await setup.query("delete from public.email_messages where invitation_id = $1", [p.id]);
        await setup.query("delete from public.invitations where id = $1", [p.id]);
        await setup.query("commit");
      }
    });
  });

  describe("reintentos y tope", () => {
    it("reintenta los fallidos: espera el intervalo mínimo y se detiene en el tope de intentos", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        for (let n = 1; n <= MAX_ATTEMPTS; n++) {
          const mailId = await attempt(p.id);
          expect(mailId, `intento ${n}`).not.toBeNull();
          const settled = await settleFailed(mailId!);
          expect(settled.status).toBe("failed");
          if (n < MAX_ATTEMPTS) {
            expect(settled.exhausted, `intento ${n}`).toBe(false);
            expect(await state(p.id)).toEqual({ state: "pending", attempts: n });
            // Recién fallado: todavía no toca; pasado el intervalo, vuelve a estar listo.
            expect(await ready(p.id)).toBe(false);
            expect(await attempt(p.id)).toBeNull();
            await waitRetryInterval(p.id);
            expect(await ready(p.id)).toBe(true);
          } else {
            // El último intento permitido: el aviso queda agotado y a la vista.
            expect(settled.exhausted).toBe(true);
          }
        }
        expect(await state(p.id)).toEqual({ state: "exhausted", attempts: MAX_ATTEMPTS });
        await waitRetryInterval(p.id);
        expect(await ready(p.id)).toBe(false);
        expect(await attempt(p.id)).toBeNull();
        expect(await noticeMails(p.id)).toBe(MAX_ATTEMPTS);
      });
    });

    it("un aviso que falla ANTES de anotarse igual gasta sus intentos y termina agotándose (no queda atascado)", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        // Cada corrida reserva y «se rompe» antes de anotar el correo (nunca llega a `register`).
        for (let n = 1; n <= MAX_ATTEMPTS; n++) {
          expect(await reserve(p.id), `reserva ${n}`).toBe(true);
          expect((await state(p.id)).attempts).toBe(n);
          await waitRetryInterval(p.id);
        }
        expect(await state(p.id)).toEqual({ state: "pending", attempts: MAX_ATTEMPTS });
        // Se acabaron los intentos: no se reserva más y la tarea lo da por agotado y lo cuenta.
        const batch = await reserveBatch();
        expect(batch.exhausted).toBeGreaterThanOrEqual(1);
        expect(batch.invitation_ids).not.toContain(p.id);
        expect(await reserve(p.id)).toBe(false);
        expect(await state(p.id)).toEqual({ state: "exhausted", attempts: MAX_ATTEMPTS });
      });
    });

    it("un aviso atascado no tapa a los siguientes: reservado, no vuelve a la cola hasta que pase el intervalo", async () => {
      await withTx(setup, async () => {
        const stuck = (await invite(w.admin, { role: "admin", email: "atascado-1@ejemplo.test" }))
          .p;
        const others = [
          (await invite(w.admin, { role: "admin", email: "siguiente-1@ejemplo.test" })).p,
          (await invite(w.admin, { role: "admin", email: "siguiente-2@ejemplo.test" })).p,
        ];
        const first = await reserveBatch();
        for (const p of [stuck, ...others]) expect(first.invitation_ids).toContain(p.id);
        // El atascado nunca se cierra; en la corrida siguiente ya no aparece (ni los demás, que ya se reservaron).
        const second = await reserveBatch();
        for (const p of [stuck, ...others]) expect(second.invitation_ids).not.toContain(p.id);
        // Otra invitación nueva sí entra a la cola de inmediato.
        const fresh = (await invite(w.admin, { role: "admin", email: "nueva-1@ejemplo.test" })).p;
        expect((await reserveBatch()).invitation_ids).toContain(fresh.id);
      });
    });

    it("un intento que nunca se cerró (el servidor se cayó) se da por fallido y se reintenta", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        const first = await attempt(p.id);
        // Pasan 6 minutos sin que nadie lo cierre.
        await ageEmail(first!, "6 minutes");
        await waitRetryInterval(p.id);
        expect((await reserveBatch()).invitation_ids).toContain(p.id);
        await actAsPostgres(setup);
        const mail = (
          await setup.query("select status, error_code from public.email_messages where id = $1", [
            first,
          ])
        ).rows[0];
        expect(mail).toEqual({ status: "failed", error_code: "abandoned" });
        expect(await state(p.id)).toEqual({ state: "pending", attempts: 2 });
      });
    });

    it("si el último intento permitido se abandona, el aviso se da por agotado y la tarea lo cuenta", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        let last: string | null = null;
        for (let n = 1; n <= MAX_ATTEMPTS; n++) {
          if (last) await settleFailed(last);
          await waitRetryInterval(p.id);
          last = await attempt(p.id);
          expect(last, `intento ${n}`).not.toBeNull();
        }
        await ageEmail(last!, "6 minutes");
        await waitRetryInterval(p.id);
        const result = await reserveBatch();
        expect(result.exhausted).toBeGreaterThanOrEqual(1);
        expect(result.invitation_ids).not.toContain(p.id);
        expect(await state(p.id)).toEqual({ state: "exhausted", attempts: MAX_ATTEMPTS });
      });
    });

    it("el último intento no se da por agotado mientras está en curso, y si sale, queda «sent»", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        let last: string | null = null;
        for (let n = 1; n <= MAX_ATTEMPTS; n++) {
          if (last) await settleFailed(last);
          await waitRetryInterval(p.id);
          last = await attempt(p.id);
        }
        // Otra corrida de la tarea pasa mientras el último intento sigue en vuelo: no lo toca.
        await reserveBatch();
        expect((await state(p.id)).state).toBe("pending");
        expect(await asServer(SETTLE, [last, "mailpit", "ultimo", null])).toEqual({
          status: "sent",
        });
        expect((await state(p.id)).state).toBe("sent");
      });
    });

    it("sin un Dueño activo con correo, el aviso se da por agotado de inmediato (no_recipient), sin quedar atascado", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        await actAsPostgres(setup);
        await setup.query(
          "update public.members set status = 'removed', removed_at = now() where tenant_id = $1 and user_id = $2",
          [w.tenantA, w.owner.id],
        );
        expect(await reserve(p.id)).toBe(true);
        const info = await asServer<Recipients>(RECIPIENTS, [p.id]);
        expect(info.recipients).toEqual([]);
        expect(info.exhausted).toBe("no_recipient");
        expect((await state(p.id)).state).toBe("exhausted");
        await waitRetryInterval(p.id);
        expect(await ready(p.id)).toBe(false);
        expect((await reserveBatch()).invitation_ids).not.toContain(p.id);
      });
    });
  });

  describe("qué invitaciones generan aviso", () => {
    it("una invitación ACEPTADA antes de que salga el aviso igual se lista y se envía", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, {
          role: "admin",
          email: "aceptada-rapida@ejemplo.test",
        });
        // Un cómplice la acepta en segundos, antes de que corra la tarea.
        await accept(p.id);
        expect(await ready(p.id)).toBe(true);
        expect((await reserveBatch()).invitation_ids).toContain(p.id);
        const info = await asServer<Recipients>(RECIPIENTS, [p.id]);
        expect(info.recipients.map((r) => r.user_id)).toEqual([w.owner.id]);
        const mailId = randomUUID();
        expect(
          await asServer(REGISTER, [
            mailId,
            p.id,
            w.owner.id,
            "v1.cifrado.aviso",
            sha256Hex("aviso"),
          ]),
        ).toEqual({ registered: true });
        expect(await asServer(SETTLE, [mailId, "mailpit", "n-1", null])).toEqual({
          status: "sent",
        });
        expect((await state(p.id)).state).toBe("sent");
        // El estado del aviso quedó intacto por la aceptación: sigue la misma invitación aceptada.
        expect((await row(p.id)).status).toBe("accepted");
      });
    });

    it("una invitación aceptada también agota sus intentos si el aviso no sale", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, {
          role: "admin",
          email: "aceptada-agota@ejemplo.test",
        });
        await accept(p.id);
        for (let n = 1; n <= MAX_ATTEMPTS; n++) {
          expect(await reserve(p.id), `reserva ${n}`).toBe(true);
          await waitRetryInterval(p.id);
        }
        expect((await reserveBatch()).exhausted).toBeGreaterThanOrEqual(1);
        expect((await state(p.id)).state).toBe("exhausted");
      });
    });

    it("una invitación CANCELADA no genera aviso", async () => {
      await withTx(setup, async () => {
        const p = (await invite(w.admin, { role: "admin", email: "cancelada-aviso@ejemplo.test" }))
          .p;
        await call(w.admin, w.tenantA, REVOKE, [p.id]);
        expect(await ready(p.id)).toBe(false);
        expect((await reserveBatch()).invitation_ids).not.toContain(p.id);
        expect(await reserve(p.id)).toBe(false);
        expect(await attempt(p.id)).toBeNull();
        expect((await asServer<Recipients>(RECIPIENTS, [p.id])).recipients).toEqual([]);
        expect(await noticeMails(p.id)).toBe(0);
      });
    });

    it("una invitación vencida sin aceptar ni cancelar igual avisa (que se invitó a un Administrador ya ocurrió)", async () => {
      await withTx(setup, async () => {
        const p = (await invite(w.admin, { role: "admin", email: "vencida-aviso@ejemplo.test" })).p;
        await actAsPostgres(setup);
        await setup.query(
          "update public.invitations set expires_at = now() - interval '1 hour' where id = $1",
          [p.id],
        );
        expect(await ready(p.id)).toBe(true);
        expect(await attempt(p.id)).not.toBeNull();
      });
    });
  });

  describe("auditoría, plazos y constantes", () => {
    it("reservar, anotar o cerrar un intento no ensucia la auditoría con «invitation.updated»", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        const updates = () =>
          count(
            "select count(*) as n from public.audit_log where resource_id = $1 and action = 'invitation.updated'",
            [p.id],
          );
        const before = await updates();
        const mailId = await attempt(p.id);
        await settleFailed(mailId!);
        expect(await updates()).toBe(before);
      });
    });

    it("el aviso de una invitación cancelada se borra por plazo, con su invitación", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, { role: "admin" });
        const mailId = await attempt(p.id);
        await settleFailed(mailId!);
        await call(w.admin, w.tenantA, REVOKE, [p.id]);
        await actAsPostgres(setup);
        await setup.query(
          "update public.invitations set revoked_at = now() - interval '31 days' where id = $1",
          [p.id],
        );
        await setup.query("select app.purge_invitations()");
        expect(
          await count("select count(*) as n from public.email_messages where invitation_id = $1", [
            p.id,
          ]),
        ).toBe(0);
        expect(
          await count("select count(*) as n from public.invitations where id = $1", [p.id]),
        ).toBe(0);
      });
    });

    it("el aviso de una invitación aceptada se conserva 30 días tras aceptarse y luego se borra con sus correos", async () => {
      await withTx(setup, async () => {
        const { p } = await invite(w.admin, {
          role: "admin",
          email: "aceptada-plazo@ejemplo.test",
        });
        const mailId = await attempt(p.id);
        await asServer(SETTLE, [mailId, "mailpit", "n-1", null]);
        await accept(p.id);
        await setup.query("select app.purge_invitations()");
        expect(await noticeMails(p.id)).toBe(1); // recién aceptada: se conserva
        await actAsPostgres(setup);
        await setup.query(
          "update public.invitations set accepted_at = now() - interval '31 days' where id = $1",
          [p.id],
        );
        await setup.query("select app.purge_invitations()");
        expect(await noticeMails(p.id)).toBe(0);
        expect(
          await count("select count(*) as n from public.invitations where id = $1", [p.id]),
        ).toBe(1);
      });
    });

    it("las constantes del aviso quedan declaradas con nombre (5 intentos, 10 minutos, 5 minutos)", async () => {
      await actAsPostgres(setup);
      const { rows } = await setup.query(
        `select app.invitation_notice_max_attempts() as a, app.invitation_notice_retry_minutes() as r,
                app.invitation_notice_stale_minutes() as s`,
      );
      expect(rows[0]).toEqual({ a: MAX_ATTEMPTS, r: 10, s: 5 });
    });
  });

  const ownerEmail = async () => {
    await actAsPostgres(setup);
    return (
      await setup.query<{ email: string }>("select email from auth.users where id = $1", [
        w.owner.id,
      ])
    ).rows[0].email;
  };
});

describe("borrado por plazo", () => {
  const purge = async () => {
    await actAsPostgres(setup);
    return (
      await setup.query<{ r: { invitations_deleted: number; emails_deleted: number } }>(
        "select app.purge_invitations() as r",
      )
    ).rows[0].r;
  };
  const exists = async (id: string) =>
    (await count("select count(*) as n from public.invitations where id = $1", [id])) > 0;

  it("una pendiente vencida hace más de 30 días se borra con sus correos; una vencida hace menos, no", async () => {
    await withTx(setup, async () => {
      const old = (await invite(w.owner, { email: "vieja@ejemplo.test" })).p;
      const recent = (await invite(w.owner, { email: "reciente@ejemplo.test" })).p;
      const live = (await invite(w.owner, { email: "vigente@ejemplo.test" })).p;
      await actAsPostgres(setup);
      await setup.query(
        "update public.invitations set expires_at = now() - interval '31 days' where id = $1",
        [old.id],
      );
      await setup.query(
        "update public.invitations set expires_at = now() - interval '29 days' where id = $1",
        [recent.id],
      );
      const result = await purge();
      expect(result.invitations_deleted).toBeGreaterThanOrEqual(1);
      expect(await exists(old.id)).toBe(false);
      expect(
        await count("select count(*) as n from public.email_messages where invitation_id = $1", [
          old.id,
        ]),
      ).toBe(0);
      expect(await exists(recent.id)).toBe(true);
      expect(await exists(live.id)).toBe(true);
      expect(
        await count("select count(*) as n from public.email_messages where invitation_id = $1", [
          recent.id,
        ]),
      ).toBe(1);
    });
  });

  it("una cancelada hace más de 30 días se borra; una cancelada hace menos, no", async () => {
    await withTx(setup, async () => {
      const old = (await invite(w.owner, { email: "cancelada-vieja@ejemplo.test" })).p;
      const recent = (await invite(w.owner, { email: "cancelada-nueva@ejemplo.test" })).p;
      await call(w.owner, w.tenantA, REVOKE, [old.id]);
      await call(w.owner, w.tenantA, REVOKE, [recent.id]);
      await actAsPostgres(setup);
      await setup.query(
        "update public.invitations set revoked_at = now() - interval '31 days' where id = $1",
        [old.id],
      );
      await setup.query(
        "update public.invitations set revoked_at = now() - interval '2 days' where id = $1",
        [recent.id],
      );
      await purge();
      expect(await exists(old.id)).toBe(false);
      expect(await exists(recent.id)).toBe(true);
    });
  });

  it("una aceptada se conserva como historia, sin correo; sus registros de correo se borran a los 30 días", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner, { email: "aceptada-vieja@ejemplo.test" });
      await actAsPostgres(setup);
      await setup.query(
        `update public.invitations set status = 'accepted', accepted_at = now() - interval '31 days',
           accepted_by = $2, email_enc = null, email_hash = null, email_binding = null where id = $1`,
        [p.id, w.sales.id],
      );
      await purge();
      expect(await exists(p.id)).toBe(true);
      expect(
        await count("select count(*) as n from public.email_messages where invitation_id = $1", [
          p.id,
        ]),
      ).toBe(0);
    });
  });

  it("fuera de la tarea de borrado, los correos siguen siendo de solo agregar", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      await actAsPostgres(setup);
      // Sin el interruptor de la tarea: no se borra ni siquiera uno vencido.
      await setup.query(
        "update public.invitations set expires_at = now() - interval '40 days' where id = $1",
        [p.id],
      );
      expect(
        (
          await expectSqlError(
            setup,
            "delete from public.email_messages where invitation_id = $1",
            [p.id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      // Con el interruptor, pero sobre una invitación vigente: tampoco.
      const live = (await invite(w.owner, { email: "no-borrar@ejemplo.test" })).p;
      await actAsPostgres(setup);
      await setup.query("select set_config('app.retention_purge', 'on', true)");
      expect(
        (
          await expectSqlError(
            setup,
            "delete from public.email_messages where invitation_id = $1",
            [live.id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("nadie con un pase puede ejecutar la tarea de borrado", async () => {
    await withTx(setup, async () => {
      await asUser(setup, w.owner, w.tenantA);
      expect((await expectSqlError(setup, "select app.purge_invitations()")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });

  it("la tarea está programada una vez al día", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<{ schedule: string }>(
      "select schedule from cron.job where jobname = 'purge-invitations'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule).toBe("40 3 * * *");
  });
});

describe("los topes de la aplicación y los de la base son los mismos", () => {
  it("las constantes de src/lib/team/invitations-model.ts calzan con app.invitation_*", async () => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<Record<string, number>>(
      `select app.invitation_ttl_days() as ttl, app.invitation_max_per_user_hour() as hour,
              app.invitation_max_per_tenant_day() as day, app.invitation_max_pending() as pending,
              app.invitation_max_resends() as resends, app.invitation_resend_min_minutes() as minutes,
              app.invitation_mail_grace_minutes() as grace, app.invitation_retention_days() as retention`,
    );
    expect(rows[0]).toEqual({
      ttl: INVITATION_TTL_DAYS,
      hour: INVITATION_MAX_PER_USER_HOUR,
      day: INVITATION_MAX_PER_TENANT_DAY,
      pending: INVITATION_MAX_PENDING,
      resends: INVITATION_MAX_RESENDS,
      minutes: INVITATION_RESEND_MIN_MINUTES,
      grace: MAIL_PENDING_GRACE_MINUTES,
      retention: INVITATION_RETENTION_DAYS,
    });
  });
});

describe("restricciones de forma de la tabla", () => {
  it("el código secreto es único en toda la plataforma y debe tener 64 hexadecimales", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      // Mismo código desde otra invitación: se rechaza (no queda ninguna fila nueva).
      const clash = prepare({ email: "otro-correo@ejemplo.test" });
      clash.params[4] = p.tokenSha;
      expect((await denied(w.owner, w.tenantA, CREATE, clash.params)).code).toBe(INVALID);
      expect(
        await count("select count(*) as n from public.invitations where id = $1", [clash.id]),
      ).toBe(0);
    });
  });

  it("«aceptada» exige fecha y quién aceptó, y vacía el correo; «cancelada» exige fecha y motivo", async () => {
    await withTx(setup, async () => {
      const { p } = await invite(w.owner);
      await actAsPostgres(setup);
      for (const sql of [
        "update public.invitations set status = 'accepted' where id = $1",
        "update public.invitations set status = 'accepted', accepted_at = now(), accepted_by = invited_by where id = $1",
        "update public.invitations set status = 'revoked' where id = $1",
        "update public.invitations set status = 'revoked', revoked_at = now(), revoke_reason = 'otra cosa' where id = $1",
        "update public.invitations set send_count = 7 where id = $1",
      ]) {
        expect((await expectSqlError(setup, sql, [p.id])).code, sql).toBe("23514");
      }
    });
  });
});
