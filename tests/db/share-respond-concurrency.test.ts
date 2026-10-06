// Sprint 3 · M23 · Respuestas del cliente a la vez: una sola respuesta, un solo evento, y coherencia
// entre aceptar y revocar. Usa conexiones reales a Postgres, cada una en su propia transacción.
// Deja datos ficticios confirmados.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "./helpers";
import {
  actAsService,
  asUser,
  buildWorld,
  sendQuoteAs,
  type SentQuote,
  type World,
} from "./send-helpers";

let setup: Client;
let w: World;
beforeAll(async () => {
  setup = await connect();
  w = await buildWorld(setup);
});
afterAll(async () => {
  await setup.end();
});

async function sentQuote(): Promise<SentQuote> {
  await setup.query("begin");
  const q = await sendQuoteAs(setup, w.sales, w.tenantA, w.customerA);
  await setup.query("commit");
  return q;
}

const RESPOND_SQL =
  "select public.share_link_respond($1, $2, $3, $4, $5, $6, $7, $8, null, $9, $10) as r";
type Result = { result: string; replayed?: boolean; decision?: string };

/** Corre una función como el servidor, en su propia conexión y transacción. */
async function inOwnTx<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect();
  try {
    await client.query("begin");
    const out = await work(client);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

function respondAs(
  q: SentQuote,
  decision: "accepted" | "rejected",
  key = randomUUID(),
): Promise<Result> {
  return inOwnTx(async (client) => {
    await actAsService(client);
    const accepted = decision === "accepted";
    const { rows } = await client.query<{ r: Result }>(RESPOND_SQL, [
      q.sha,
      randomUUID(),
      key,
      decision,
      accepted ? "v1.nombre.cifrado" : null,
      accepted ? null : "timing",
      null,
      "v1.ip.ip",
      "Mozilla",
      accepted ? "v1" : null,
    ]);
    return rows[0].r;
  });
}

const revokeAs = (q: SentQuote) =>
  inOwnTx(async (client) => {
    await asUser(client, w.sales, w.tenantA);
    const { rows } = await client.query<{ n: number }>(
      "select public.revoke_quote_links($1) as n",
      [q.quoteId],
    );
    return rows[0].n;
  });

async function stateOf(q: SentQuote) {
  const quote = await setup.query<{ status: string }>(
    "select status from public.quotes where id = $1",
    [q.quoteId],
  );
  const responses = await setup.query<{ decision: string }>(
    "select decision from public.quote_responses where quote_id = $1",
    [q.quoteId],
  );
  const events = await setup.query<{ type: string }>(
    "select type from public.quote_events where quote_id = $1 and type in ('accepted', 'rejected_by_customer')",
    [q.quoteId],
  );
  const link = await setup.query<{ revoked_at: string | null }>(
    "select revoked_at from public.share_links where id = $1",
    [q.linkId],
  );
  return {
    status: quote.rows[0].status,
    responses: responses.rows,
    events: events.rows,
    revokedAt: link.rows[0].revoked_at,
  };
}

describe("respuestas simultáneas", () => {
  it("20 aceptaciones a la vez con la misma clave: 1 respuesta y 1 evento; todas reciben 'ok'", async () => {
    const q = await sentQuote();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => respondAs(q, "accepted", key)),
    );
    expect(results.every((r) => r.result === "ok" && r.decision === "accepted")).toBe(true);
    expect(results.filter((r) => r.replayed === false)).toHaveLength(1);
    const s = await stateOf(q);
    expect(s.status).toBe("accepted");
    expect(s.responses).toHaveLength(1);
    expect(s.events).toEqual([{ type: "accepted" }]);
  });

  it("aceptar y rechazar a la vez: una gana, las demás ven 'ya respondida' con la decisión que quedó", async () => {
    const q = await sentQuote();
    const attempts = [
      ...Array.from({ length: 10 }, () => respondAs(q, "accepted")),
      ...Array.from({ length: 10 }, () => respondAs(q, "rejected")),
    ];
    const results = await Promise.all(attempts);
    const winners = results.filter((r) => r.result === "ok");
    expect(winners).toHaveLength(1);
    const winner = winners[0].decision!;
    expect(
      results.filter((r) => r.result === "already_responded").every((r) => r.decision === winner),
    ).toBe(true);
    expect(results.filter((r) => r.result === "already_responded")).toHaveLength(19);
    const s = await stateOf(q);
    expect(s.status).toBe(winner === "accepted" ? "accepted" : "rejected_by_customer");
    expect(s.responses).toEqual([{ decision: winner }]);
    expect(s.events).toHaveLength(1);
  });

  it("aceptar y revocar a la vez dejan un estado coherente (nunca una aceptación sin respuesta ni al revés)", async () => {
    for (let round = 0; round < 6; round++) {
      const q = await sentQuote();
      const [response] = await Promise.all([respondAs(q, "accepted"), revokeAs(q)]);
      const s = await stateOf(q);
      // el enlace termina revocado en todos los casos
      expect(s.revokedAt, `ronda ${round}`).not.toBeNull();
      if (response.result === "ok") {
        // aceptó antes de que se revocara: la respuesta existe y es firme
        expect(s.status).toBe("accepted");
        expect(s.responses).toEqual([{ decision: "accepted" }]);
        expect(s.events).toHaveLength(1);
      } else {
        // se revocó primero: no hay respuesta y la cotización sigue enviada
        expect(response.result).toBe("revoked");
        expect(s.status).toBe("sent");
        expect(s.responses).toEqual([]);
        expect(s.events).toEqual([]);
      }
    }
  });
});
