// Sprint 3 Â· migraciÃ³n 26 Â· correcciones de la revisiÃ³n: el enlace revocado entremedio (I1), el orden de
// bloqueo sin choques (I5) y los menores (primera apertura, organizaciÃ³n archivada, enlace anulado,
// historial de pg_cron). Las pruebas con varias conexiones dejan datos ficticios confirmados; las demÃ¡s
// corren en una transacciÃ³n que se deshace.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import {
  actAsService,
  asUser,
  buildWorld,
  createQuote,
  newToken,
  sendQuoteAs,
  sha256Hex,
  type SentQuote,
  type World,
} from "./send-helpers";

const FORBIDDEN = "42501";

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

async function service<T = Json>(db: Client, sql: string, params: unknown[]): Promise<T> {
  await actAsService(db);
  const { rows } = await db.query<{ r: T }>(sql, params);
  await actAsPostgres(db);
  return rows[0].r;
}
const read = (sha: string) => service(setup, "select public.share_link_read($1) as r", [sha]);
const view = (sha: string) =>
  service(setup, "select public.share_link_record_view($1, 'v1.ip.ip', 'Mozilla') as r", [sha]);

const RESPOND_SQL =
  "select public.share_link_respond($1, $2, $3, 'accepted', 'v1.nombre.cifrado', null, null, 'v1.ip.ip', null, 'Mozilla', 'v1') as r";
const respondArgs = (sha: string) => [sha, randomUUID(), randomUUID()];
const respond = (sha: string) => service(setup, RESPOND_SQL, respondArgs(sha));

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  await actAsPostgres(setup);
  const { rows } = await setup.query(sql, params);
  return rows[0] as T;
}
const count = async (sql: string, params: unknown[] = []) =>
  Number((await one<{ n: string }>(sql, params)).n);
const quoteRow = (id: string) => one<Json>("select * from public.quotes where id = $1", [id]);

describe("menores de la migraciÃ³n 26", () => {
  const send = () => sendQuoteAs(setup, w.sales, w.tenantA, w.customerA);

  it("responder sin haber abierto fija la primera apertura: una apertura posterior no registra Â«VistaÂ»", async () => {
    await withTx(setup, async () => {
      const q = await send();
      expect(await respond(q.sha)).toMatchObject({ result: "ok", decision: "accepted" });
      expect((await quoteRow(q.quoteId)).first_viewed_at).not.toBeNull();
      expect(await view(q.sha)).toMatchObject({ recorded: true });
      expect(
        await count(
          "select count(*)::text as n from public.quote_events where quote_id = $1 and type = 'viewed'",
          [q.quoteId],
        ),
      ).toBe(0);
      expect(await quoteRow(q.quoteId)).toMatchObject({ status: "accepted" });
    });
  });

  it("con la organizaciÃ³n archivada el enlace no existe para nadie (leer, abrir y responder)", async () => {
    await withTx(setup, async () => {
      const q = await send();
      await setup.query("update public.tenants set status = 'archived' where tenant_id = $1", [
        w.tenantA,
      ]);
      expect(await read(q.sha)).toEqual({ state: "not_found" });
      expect(await view(q.sha)).toEqual({ recorded: false });
      expect(await respond(q.sha)).toEqual({ result: "not_found" });
      expect(await quoteRow(q.quoteId)).toMatchObject({ status: "sent" });
    });
  });

  it("un enlace anulado no se puede activar", async () => {
    await withTx(setup, async () => {
      const q = await send();
      const emailId = randomUUID();
      await setup.query(
        `insert into public.email_messages (id, tenant_id, quote_id, package_id, kind, to_email_enc, to_email_hash, provider)
         values ($1, $2, $3, $4, 'quote_resend', 'x', $5, 'pending')`,
        [emailId, w.tenantA, q.quoteId, q.packageId, sha256Hex("z")],
      );
      const linkId = randomUUID();
      await setup.query(
        "insert into public.share_links (id, tenant_id, quote_id, package_id, email_message_id, token_sha256) values ($1, $2, $3, $4, $5, $6)",
        [linkId, w.tenantA, q.quoteId, q.packageId, emailId, newToken().sha],
      );
      await setup.query(
        "update public.share_links set revoked_at = now(), revoke_reason = 'failed_attempt' where id = $1",
        [linkId],
      );
      const err = await expectSqlError(
        setup,
        "update public.share_links set activated_at = now() where id = $1",
        [linkId],
      );
      expect(err.code).toBe(FORBIDDEN);
    });
  });

  it("el vencimiento programado limpia el historial de pg_cron de mÃ¡s de 7 dÃ­as y deja el reciente", async () => {
    await withTx(setup, async () => {
      const insert = (daysAgo: number) =>
        setup.query(
          `insert into cron.job_run_details (runid, jobid, database, username, command, status, start_time, end_time)
           values (987654000 + $1, 987654321, 'postgres', 'postgres', 'select 1', 'succeeded',
                   now() - make_interval(days => $1), now() - make_interval(days => $1))`,
          [daysAgo],
        );
      await insert(10);
      await insert(1);
      await one("select app.expire_due_quotes() as n");
      expect(
        await count("select count(*)::text as n from cron.job_run_details where jobid = 987654321"),
      ).toBe(1);
    });
  });
});

/** Espera a que otra conexiÃ³n estÃ© bloqueada esperando una fila dentro de la funciÃ³n `fn`. */
async function waitUntilBlocked(fn: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await setup.query(
      `select 1 from pg_stat_activity
        where wait_event_type = 'Lock' and query ilike $1 and pid <> pg_backend_pid()`,
      [`%${fn}%`],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`nadie quedÃ³ esperando en ${fn}`);
}

describe("I1 Â· una revocaciÃ³n que termina entremedio no se salta", () => {
  async function sentQuote(): Promise<SentQuote> {
    await setup.query("begin");
    const q = await sendQuoteAs(setup, w.sales, w.tenantA, w.customerA);
    await setup.query("commit");
    return q;
  }

  /** Abre la revocaciÃ³n (con la cotizaciÃ³n bloqueada), lanza `blocked` y confirma la revocaciÃ³n. */
  async function revokeWhileBlocked<T>(
    q: SentQuote,
    fn: string,
    blocked: (client: Client) => Promise<T>,
  ): Promise<T> {
    const revoker = await connect();
    const other = await connect();
    try {
      await revoker.query("begin");
      await asUser(revoker, w.sales, w.tenantA);
      await revoker.query("select public.revoke_quote_links($1)", [q.quoteId]);
      await other.query("begin");
      await actAsService(other);
      const pending = blocked(other);
      await waitUntilBlocked(fn);
      await revoker.query("commit");
      const result = await pending;
      await other.query("commit");
      return result;
    } finally {
      await revoker.end();
      await other.end();
    }
  }

  it("responder: la respuesta que ya habÃ­a leÃ­do el enlace como vigente falla con 'revoked'", async () => {
    const q = await sentQuote();
    const result = await revokeWhileBlocked(q, "share_link_respond", async (client) => {
      const { rows } = await client.query<{ r: Json }>(RESPOND_SQL, respondArgs(q.sha));
      return rows[0].r;
    });
    expect(result).toEqual({ result: "revoked" });
    expect(await quoteRow(q.quoteId)).toMatchObject({ status: "sent" });
    expect(
      await count("select count(*)::text as n from public.quote_responses where quote_id = $1", [
        q.quoteId,
      ]),
    ).toBe(0);
  });

  it("abrir: la apertura que ya habÃ­a leÃ­do el enlace como vigente no se anota", async () => {
    const q = await sentQuote();
    const result = await revokeWhileBlocked(q, "share_link_record_view", async (client) => {
      const { rows } = await client.query<{ r: Json }>(
        "select public.share_link_record_view($1, 'v1.ip.ip', 'Mozilla') as r",
        [q.sha],
      );
      return rows[0].r;
    });
    expect(result).toEqual({ recorded: false });
    expect(
      await count(
        "select count(*)::text as n from public.share_link_views where share_link_id = $1",
        [q.linkId],
      ),
    ).toBe(0);
    expect(await quoteRow(q.quoteId)).toMatchObject({ status: "sent" });
  });
});

describe("I5 Â· enviar con reintento no se bloquea entre sÃ­ (sin 40P01)", () => {
  interface Prepared {
    quoteId: string;
    packageId: string;
    emailId: string;
    sha: string;
  }

  /** CotizaciÃ³n con envÃ­o preparado y PDF adjunto, sin confirmar, con el candado ya vencido. */
  async function slowSend(): Promise<Prepared> {
    await setup.query("begin");
    const quoteId = await createQuote(setup, w.sales, w.tenantA, w.customerA);
    const { rows } = await setup.query<{ revision: number }>(
      "select revision from public.quotes where id = $1",
      [quoteId],
    );
    const packageId = randomUUID();
    const emailId = randomUUID();
    const { sha } = newToken();
    await asUser(setup, w.sales, w.tenantA);
    await setup.query(
      "select public.prepare_quote_send($1, $2, $3, $4, $5, $6, $7, 'Su cotizaciÃ³n', 'Hola', 'v1.to.to', $8, 'v1.snap.snap')",
      [
        quoteId,
        rows[0].revision,
        randomUUID(),
        packageId,
        emailId,
        randomUUID(),
        sha,
        sha256Hex("cliente@ejemplo.test"),
      ],
    );
    await actAsPostgres(setup);
    const pdfPath = `${w.tenantA}/${quoteId}/${packageId}.pdf`;
    await setup.query(
      "insert into storage.objects (bucket_id, name, metadata) values ('quote-documents', $1, $2::jsonb)",
      [pdfPath, JSON.stringify({ size: 1234 })],
    );
    await asUser(setup, w.sales, w.tenantA);
    await setup.query(
      "select public.attach_quote_package_document($1, $2, $3, 1234, null, '{\"ok\":true}'::jsonb, $4, $5)",
      [packageId, pdfPath, sha256Hex("pdf"), sha256Hex("contenido"), sha],
    );
    await actAsPostgres(setup);
    await setup.query(
      "update public.quotes set send_lock_until = now() - interval '1 second' where id = $1",
      [quoteId],
    );
    await setup.query("commit");
    return { quoteId, packageId, emailId, sha };
  }

  async function inOwnTx(work: (client: Client) => Promise<unknown>): Promise<string> {
    const client = await connect();
    try {
      await client.query("begin");
      await asUser(client, w.sales, w.tenantA);
      await work(client);
      await client.query("commit");
      return "ok";
    } catch (error) {
      await client.query("rollback");
      return (error as { code?: string }).code ?? "error";
    } finally {
      await client.end();
    }
  }

  it("el reintento (que abandona el envÃ­o lento) y la confirmaciÃ³n del envÃ­o lento, a la vez, nunca se traban", async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 8; round++) {
      const slow = await slowSend();
      const { rows } = await setup.query<{ revision: number }>(
        "select revision from public.quotes where id = $1",
        [slow.quoteId],
      );
      const results = await Promise.all([
        inOwnTx((client) =>
          client.query(
            "select public.prepare_quote_send($1, $2, $3, $4, $5, $6, $7, 'Su cotizaciÃ³n', 'Hola', 'v1.to.to', $8, 'v1.snap.snap')",
            [
              slow.quoteId,
              rows[0].revision,
              randomUUID(),
              randomUUID(),
              randomUUID(),
              randomUUID(),
              newToken().sha,
              sha256Hex("cliente@ejemplo.test"),
            ],
          ),
        ),
        inOwnTx((client) =>
          client.query("select public.confirm_email_dispatch($1, 'memory', $2, $3)", [
            slow.emailId,
            `prov-${slow.emailId}`,
            slow.sha,
          ]),
        ),
        inOwnTx((client) =>
          client.query("select public.fail_email_dispatch($1, 'smtp_timeout', $2)", [
            slow.emailId,
            slow.sha,
          ]),
        ),
      ]);
      outcomes.push(...results);
    }
    expect(outcomes).not.toContain("40P01");
    expect(outcomes).not.toContain("error");
  });
});
