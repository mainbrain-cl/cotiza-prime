// Sprint 3 · M22 · Diez envíos a la vez de la misma cotización: un solo paquete y un solo correo.
// Usa conexiones reales a Postgres, cada una en su propia transacción. Deja datos ficticios confirmados.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "./helpers";
import { asUser, buildWorld, createQuote, newToken, sha256Hex, type World } from "./send-helpers";

const PARALLEL = 10;
const PREPARE_SQL =
  "select public.prepare_quote_send($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as r";

let setup: Client;
let w: World;
beforeAll(async () => {
  setup = await connect();
  w = await buildWorld(setup);
});
afterAll(async () => {
  await setup.end();
});

type Outcome = { ok: true; status: string } | { ok: false; code: string | undefined };

async function prepareAll(quoteId: string, revision: number, sameKey: boolean): Promise<Outcome[]> {
  const sharedKey = randomUUID();
  const clients = await Promise.all(Array.from({ length: PARALLEL }, () => connect()));
  try {
    return await Promise.all(
      clients.map(async (client): Promise<Outcome> => {
        await client.query("begin");
        try {
          await asUser(client, w.sales, w.tenantA);
          const token = newToken();
          const { rows } = await client.query<{ r: { status: string } }>(PREPARE_SQL, [
            quoteId,
            revision,
            sameKey ? sharedKey : randomUUID(),
            randomUUID(),
            randomUUID(),
            randomUUID(),
            token.sha,
            "Su cotización",
            "Hola",
            "v1.to.to",
            sha256Hex("cliente@ejemplo.test"),
            "v1.snap.snap",
          ]);
          await client.query("commit");
          return { ok: true, status: rows[0].r.status };
        } catch (error) {
          await client.query("rollback");
          return { ok: false, code: (error as { code?: string }).code };
        }
      }),
    );
  } finally {
    await Promise.all(clients.map((client) => client.end()));
  }
}

async function counts(quoteId: string) {
  const packages = await setup.query<{ n: string }>(
    "select count(*)::text as n from public.quote_packages where quote_id = $1",
    [quoteId],
  );
  const emails = await setup.query<{ n: string }>(
    "select count(*)::text as n from public.email_messages where quote_id = $1 and kind = 'quote'",
    [quoteId],
  );
  const links = await setup.query<{ n: string }>(
    "select count(*)::text as n from public.share_links where quote_id = $1",
    [quoteId],
  );
  return {
    packages: Number(packages.rows[0].n),
    emails: Number(emails.rows[0].n),
    links: Number(links.rows[0].n),
  };
}

async function freshQuote() {
  await setup.query("begin");
  const quoteId = await createQuote(setup, w.sales, w.tenantA, w.customerA);
  await setup.query("commit");
  const { rows } = await setup.query<{ revision: number }>(
    "select revision from public.quotes where id = $1",
    [quoteId],
  );
  return { quoteId, revision: rows[0].revision };
}

describe("10 envíos a la vez", () => {
  it("con claves distintas: uno prepara, los demás chocan (CP409); queda 1 paquete, 1 enlace y 1 correo", async () => {
    const { quoteId, revision } = await freshQuote();
    const outcomes = await prepareAll(quoteId, revision, false);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok).map((o) => (o as { code?: string }).code)).toEqual(
      Array(PARALLEL - 1).fill("CP409"),
    );
    expect(await counts(quoteId)).toEqual({ packages: 1, emails: 1, links: 1 });
  });

  it("con la misma clave (el mismo clic repetido): uno prepara y los demás reciben 'en curso'", async () => {
    const { quoteId, revision } = await freshQuote();
    const outcomes = await prepareAll(quoteId, revision, true);
    const statuses = outcomes.map((o) => (o.ok ? o.status : o.code)).sort();
    expect(statuses.filter((s) => s === "prepared")).toHaveLength(1);
    expect(statuses.filter((s) => s === "in_progress")).toHaveLength(PARALLEL - 1);
    expect(await counts(quoteId)).toEqual({ packages: 1, emails: 1, links: 1 });
  });
});
