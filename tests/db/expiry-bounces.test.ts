// Sprint 3 · M24 · Vencimiento programado (app.expire_due_quotes + pg_cron) y avisos del proveedor de
// correo (record_email_event). Cada prueba corre en una transacción que se deshace.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsAnon, actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import {
  actAsService,
  asUser,
  buildWorld,
  sendQuoteAs,
  type SentQuote,
  type World,
} from "./send-helpers";

const FORBIDDEN = "42501";
const INVALID = "CP422";

let db: Client;
let w: World;
beforeAll(async () => {
  db = await connect();
  w = await buildWorld(db);
});
afterAll(async () => {
  await db.end();
});

type Json = Record<string, unknown>;

const send = (tenant = w.tenantA, author = w.sales, customer = w.customerA): Promise<SentQuote> =>
  sendQuoteAs(db, author, tenant, customer);

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  await actAsPostgres(db);
  const { rows } = await db.query(sql, params);
  return rows[0] as T;
}
const count = async (sql: string, params: unknown[] = []) =>
  Number((await one<{ n: string }>(sql, params)).n);
const statusOf = async (quoteId: string) =>
  (await one<{ status: string }>("select status from public.quotes where id = $1", [quoteId]))
    .status;
const setDue = (quoteId: string, days: number) =>
  db.query(
    "update public.quotes set valid_until = app.current_business_date() + $1::int where id = $2",
    [days, quoteId],
  );
const expireNow = async () => (await one<{ n: number }>("select app.expire_due_quotes() as n")).n;

describe("app.expire_due_quotes", () => {
  it("vence las enviadas y vistas cuya vigencia terminó; no las vigentes, ni las que vencen hoy", async () => {
    await withTx(db, async () => {
      const sent = await send();
      const viewed = await send();
      const lastDay = await send();
      const future = await send();
      const otherTenant = await send(w.tenantB, w.ownerB, w.customerB);
      await setDue(sent.quoteId, -1);
      await setDue(viewed.quoteId, -5);
      await db.query("update public.quotes set status = 'viewed' where id = $1", [viewed.quoteId]);
      await setDue(lastDay.quoteId, 0); // vale hasta el último día inclusive
      await setDue(future.quoteId, 3);
      await setDue(otherTenant.quoteId, -2);
      const before = await count(
        "select count(*)::text as n from public.quotes where status = 'expired'",
      );
      expect(await expireNow()).toBeGreaterThanOrEqual(3);
      expect(await statusOf(sent.quoteId)).toBe("expired");
      expect(await statusOf(viewed.quoteId)).toBe("expired");
      expect(await statusOf(otherTenant.quoteId)).toBe("expired");
      expect(await statusOf(lastDay.quoteId)).toBe("sent");
      expect(await statusOf(future.quoteId)).toBe("sent");
      expect(
        await count("select count(*)::text as n from public.quotes where status = 'expired'"),
      ).toBeGreaterThanOrEqual(before + 3);
      // evento de sistema, una sola vez; correr de nuevo no repite nada
      const ev = await one<{ actor_type: string; actor_user_id: string | null; data: Json }>(
        "select actor_type, actor_user_id, data from public.quote_events where quote_id = $1 and type = 'expired'",
        [sent.quoteId],
      );
      expect(ev).toMatchObject({ actor_type: "system", actor_user_id: null, data: {} });
      expect(await expireNow()).toBe(0);
      expect(
        await count(
          "select count(*)::text as n from public.quote_events where quote_id = $1 and type = 'expired'",
          [sent.quoteId],
        ),
      ).toBe(1);
    });
  });

  it("una cotización aceptada o rechazada nunca vence; tampoco un borrador", async () => {
    await withTx(db, async () => {
      const accepted = await send();
      const rejected = await send();
      await actAsService(db);
      await db.query(
        "select public.share_link_respond($1, gen_random_uuid(), gen_random_uuid(), 'accepted', 'v1.n.n', null, null, null, null, null, 'v1')",
        [accepted.sha],
      );
      await db.query(
        "select public.share_link_respond($1, gen_random_uuid(), gen_random_uuid(), 'rejected', null, 'timing', null, null, null, null, null)",
        [rejected.sha],
      );
      await actAsPostgres(db);
      await setDue(accepted.quoteId, -40);
      await setDue(rejected.quoteId, -40);
      await expireNow();
      expect(await statusOf(accepted.quoteId)).toBe("accepted");
      expect(await statusOf(rejected.quoteId)).toBe("rejected_by_customer");
    });
  });

  it("salta la cotización que alguien está respondiendo en ese instante, y la toma en la corrida siguiente", async () => {
    const q = await (async () => {
      await db.query("begin");
      const sent = await send();
      await setDue(sent.quoteId, -1);
      await db.query("commit");
      return sent;
    })();
    const other = await connect();
    try {
      await other.query("begin");
      await other.query("select 1 from public.quotes where id = $1 for update", [q.quoteId]);
      await db.query("begin");
      await db.query("select app.expire_due_quotes()");
      await db.query("commit");
      expect(await statusOf(q.quoteId)).toBe("sent"); // bloqueada: se saltó
      await other.query("commit");
      await expireNow();
      expect(await statusOf(q.quoteId)).toBe("expired");
    } finally {
      await other.end();
    }
  });

  it("está programada cada hora con pg_cron", async () => {
    const job = await one<{ schedule: string; command: string; active: boolean }>(
      "select schedule, command, active from cron.job where jobname = 'expire-quotes'",
    );
    expect(job).toEqual({
      schedule: "5 * * * *",
      command: "select app.expire_due_quotes()",
      active: true,
    });
  });

  it("nadie con pase ni sin sesión la ejecuta", async () => {
    await withTx(db, async () => {
      await actAsAnon(db);
      expect((await expectSqlError(db, "select app.expire_due_quotes()")).code).toBe(FORBIDDEN);
      await asUser(db, w.owner, w.tenantA);
      expect((await expectSqlError(db, "select app.expire_due_quotes()")).code).toBe(FORBIDDEN);
    });
  });
});

describe("record_email_event", () => {
  const SQL = "select public.record_email_event($1, $2, $3, $4, $5) as r";
  const event = async (
    mail: SentQuote,
    name: string,
    at: string | null = null,
    bounce: string | null = null,
    provider = "memory",
  ) => {
    await actAsService(db);
    const { rows } = await db.query<{ r: Json }>(SQL, [
      provider,
      `prov-${mail.emailId}`,
      name,
      at,
      bounce,
    ]);
    await actAsPostgres(db);
    return rows[0].r;
  };
  const eventError = async (args: unknown[]) => {
    await actAsService(db);
    const err = await expectSqlError(db, SQL, args);
    await actAsPostgres(db);
    return err;
  };
  const mailRow = (mail: SentQuote) =>
    one<Json>("select * from public.email_messages where id = $1", [mail.emailId]);

  it("entregado: avanza una sola vez y repetir el aviso no cambia nada", async () => {
    await withTx(db, async () => {
      const q = await send();
      expect(await event(q, "delivered")).toMatchObject({ result: "applied", status: "delivered" });
      expect(await mailRow(q)).toMatchObject({ status: "delivered" });
      expect((await mailRow(q)).delivered_at).not.toBeNull();
      expect(await event(q, "delivered")).toMatchObject({ result: "ignored" });
      expect(
        await count(
          "select count(*)::text as n from public.quote_events where quote_id = $1 and type = 'email_bounced'",
          [q.quoteId],
        ),
      ).toBe(0);
    });
  });

  it("rebote: pasa por encima de 'entregado', deja un evento sin datos personales, y no se repite", async () => {
    await withTx(db, async () => {
      const q = await send();
      await event(q, "delivered");
      expect(await event(q, "bounced", null, "hard")).toMatchObject({
        result: "applied",
        status: "bounced",
      });
      expect(await mailRow(q)).toMatchObject({ status: "bounced", bounce_type: "hard" });
      expect((await mailRow(q)).bounced_at).not.toBeNull();
      const ev = await one<{ actor_type: string; data: Json }>(
        "select actor_type, data from public.quote_events where quote_id = $1 and type = 'email_bounced'",
        [q.quoteId],
      );
      expect(ev).toEqual({
        actor_type: "system",
        data: { email_message_id: q.emailId, bounce_type: "hard" },
      });
      expect(await event(q, "bounced", null, "soft")).toMatchObject({ result: "ignored" });
      expect(
        await count(
          "select count(*)::text as n from public.quote_events where quote_id = $1 and type = 'email_bounced'",
          [q.quoteId],
        ),
      ).toBe(1);
      expect(await mailRow(q)).toMatchObject({ bounce_type: "hard" });
    });
  });

  it("un aviso desordenado no retrocede el estado: 'entregado' después de un rebote se ignora", async () => {
    await withTx(db, async () => {
      const q = await send();
      await event(q, "bounced", "2030-01-01T10:00:00Z", "soft");
      expect(await event(q, "delivered", "2030-01-01T09:59:00Z")).toMatchObject({
        result: "ignored",
        status: "bounced",
      });
      expect(await event(q, "delivered")).toMatchObject({ result: "ignored", status: "bounced" });
      expect(await mailRow(q)).toMatchObject({ status: "bounced" });
    });
  });

  it("un aviso más viejo que el último ya aplicado se ignora", async () => {
    await withTx(db, async () => {
      const q = await send();
      await event(q, "delivered", "2030-01-01T10:00:00Z");
      expect(await event(q, "bounced", "2030-01-01T09:00:00Z", "hard")).toMatchObject({
        result: "ignored_older",
        status: "delivered",
      });
      expect(await mailRow(q)).toMatchObject({ status: "delivered", bounce_type: null });
      // uno posterior sí se aplica
      expect(await event(q, "bounced", "2030-01-01T11:00:00Z", "hard")).toMatchObject({
        result: "applied",
      });
    });
  });

  it("una entrega muy rápida (anterior a la confirmación del envío) igual se aplica", async () => {
    await withTx(db, async () => {
      const q = await send();
      expect(await event(q, "delivered", "2000-01-01T00:00:00Z")).toMatchObject({
        result: "applied",
      });
    });
  });

  it("'reclamado como spam' pasa por encima de 'entregado' y es final", async () => {
    await withTx(db, async () => {
      const q = await send();
      await event(q, "delivered");
      expect(await event(q, "complained")).toMatchObject({
        result: "applied",
        status: "complained",
      });
      expect(await event(q, "delivered")).toMatchObject({ result: "ignored" });
      expect(await event(q, "bounced", null, "hard")).toMatchObject({ result: "ignored" });
      expect(await mailRow(q)).toMatchObject({ status: "complained" });
    });
  });

  it("un aviso de algo que no es nuestro, o de otro proveedor, es 'desconocido' y no cambia nada", async () => {
    await withTx(db, async () => {
      const q = await send();
      expect(await event(q, "delivered", null, null, "resend")).toEqual({ result: "unknown" });
      await actAsService(db);
      const { rows } = await db.query<{ r: Json }>(SQL, [
        "memory",
        "no-existe",
        "delivered",
        null,
        null,
      ]);
      await actAsPostgres(db);
      expect(rows[0].r).toEqual({ result: "unknown" });
      expect(await mailRow(q)).toMatchObject({ status: "sent" });
    });
  });

  it("un correo fallido o que nunca salió no cambia con los avisos", async () => {
    await withTx(db, async () => {
      const q = await send();
      await db.query("alter table public.email_messages disable trigger email_messages_guard");
      await db.query("update public.email_messages set status = 'failed' where id = $1", [
        q.emailId,
      ]);
      await db.query("alter table public.email_messages enable trigger email_messages_guard");
      expect(await event(q, "delivered")).toMatchObject({ result: "ignored", status: "failed" });
    });
  });

  it("valida los argumentos (CP422)", async () => {
    await withTx(db, async () => {
      const q = await send();
      const id = `prov-${q.emailId}`;
      expect((await eventError(["memory", id, "abierto", null, null])).code).toBe(INVALID);
      expect((await eventError(["memory", id, null, null, null])).code).toBe(INVALID);
      expect((await eventError(["memory", id, "bounced", null, null])).code).toBe(INVALID);
      expect((await eventError(["memory", id, "bounced", null, "raro"])).code).toBe(INVALID);
      expect((await eventError(["MAL PROVEEDOR", id, "delivered", null, null])).code).toBe(INVALID);
      expect((await eventError(["memory", "", "delivered", null, null])).code).toBe(INVALID);
      expect((await eventError(["memory", null, "delivered", null, null])).code).toBe(INVALID);
      expect(await mailRow(q)).toMatchObject({ status: "sent" });
    });
  });

  it("el rebote de un aviso interno queda solo en email_messages; el de un reenvío sí entra en la historia", async () => {
    await withTx(db, async () => {
      const q = await send();
      const insertMail = async (kind: string, providerId: string) => {
        const id = randomUUID();
        await actAsPostgres(db);
        await db.query(
          `insert into public.email_messages
             (id, tenant_id, quote_id, package_id, kind, to_email_enc, to_email_hash, provider,
              provider_message_id, status)
           select $1, tenant_id, id, current_package_id, $2, 'v1.correo.cifrado', repeat('a', 64),
                  'memory', $3, 'sent'
             from public.quotes where id = $4`,
          [id, kind, providerId, q.quoteId],
        );
        return id;
      };
      const bounce = async (providerId: string) => {
        await actAsService(db);
        const { rows } = await db.query<{ r: Json }>(SQL, [
          "memory",
          providerId,
          "bounced",
          null,
          "hard",
        ]);
        await actAsPostgres(db);
        return rows[0].r;
      };
      const events = () =>
        count(
          "select count(*)::text as n from public.quote_events where quote_id = $1 and type = 'email_bounced'",
          [q.quoteId],
        );

      const noticeId = await insertMail("internal_notice", `notice-${randomUUID()}`);
      const notice = await one<{ provider_message_id: string }>(
        "select provider_message_id from public.email_messages where id = $1",
        [noticeId],
      );
      expect(await bounce(notice.provider_message_id)).toMatchObject({
        result: "applied",
        status: "bounced",
      });
      expect(
        await one<Json>("select status, bounce_type from public.email_messages where id = $1", [
          noticeId,
        ]),
      ).toEqual({ status: "bounced", bounce_type: "hard" });
      expect(await events()).toBe(0);

      const resendProviderId = `resend-${randomUUID()}`;
      await insertMail("quote_resend", resendProviderId);
      await bounce(resendProviderId);
      expect(await events()).toBe(1);
    });
  });

  it("solo el servidor la ejecuta: ni anon ni una persona con sesión", async () => {
    await withTx(db, async () => {
      const q = await send();
      const args = ["memory", `prov-${q.emailId}`, "bounced", null, "hard"];
      await actAsAnon(db);
      expect((await expectSqlError(db, SQL, args)).code).toBe(FORBIDDEN);
      for (const user of [w.sales, w.owner, w.ownerB]) {
        await asUser(db, user, w.tenantA);
        expect((await expectSqlError(db, SQL, args)).code).toBe(FORBIDDEN);
      }
      expect(await mailRow(q)).toMatchObject({ status: "sent" });
    });
  });
});
