// Sprint 3 · M21 · Correos enviados (email_messages) y respuestas del cliente (quote_responses).
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import {
  asUser,
  buildWorld,
  createQuote,
  insertPackage,
  newToken,
  sha256Hex,
  type World,
} from "./send-helpers";

const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";

let db: Client;
let w: World;
beforeAll(async () => {
  db = await connect();
  w = await buildWorld(db);
});
afterAll(async () => {
  await db.end();
});

interface Base {
  quoteId: string;
  packageId: string;
  linkId: string;
  emailId: string;
}

/** Cotización con paquete, enlace y correo `quote` (el enlace y el correo se apuntan entre sí). */
async function base(
  tenantId = w.tenantA,
  author = w.sales,
  customerId = w.customerA,
): Promise<Base> {
  const quoteId = await createQuote(db, author, tenantId, customerId);
  const pkg = await insertPackage(db, tenantId, quoteId, author);
  const linkId = randomUUID();
  const emailId = randomUUID();
  await db.query(
    `insert into public.share_links (id, tenant_id, quote_id, package_id, email_message_id, token_sha256)
     values ($1, $2, $3, $4, $5, $6)`,
    [linkId, tenantId, quoteId, pkg.id, emailId, newToken().sha],
  );
  await db.query(
    `insert into public.email_messages (id, tenant_id, quote_id, package_id, share_link_id, kind,
       to_email_enc, to_email_hash, provider, created_by)
     values ($1, $2, $3, $4, $5, 'quote', 'v1.x.y', $6, 'memory', $7)`,
    [emailId, tenantId, quoteId, pkg.id, linkId, sha256Hex(emailId), author.id],
  );
  return { quoteId, packageId: pkg.id, linkId, emailId };
}

const updEmail = (id: string, set: string) =>
  expectSqlError(db, `update public.email_messages set ${set} where id = $1`, [id]);

describe("email_messages", () => {
  it("el enlace y su correo se exigen mutuamente al confirmar la transacción", async () => {
    await withTx(db, async () => {
      const quoteId = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const pkg = await insertPackage(db, w.tenantA, quoteId, w.sales);
      await db.query(
        `insert into public.share_links (id, tenant_id, quote_id, package_id, email_message_id, token_sha256)
         values (gen_random_uuid(), $1, $2, $3, gen_random_uuid(), $4)`,
        [w.tenantA, quoteId, pkg.id, newToken().sha],
      );
      // la relación es "al confirmar": se fuerza ahora para comprobarla
      const err = await expectSqlError(db, "set constraints all immediate");
      expect(err.code).toBe(FK_VIOLATION);
    });
  });

  it("un solo correo `quote` por paquete (anti doble envío); los reenvíos pueden ser varios", async () => {
    await withTx(db, async () => {
      const b = await base();
      const insert = (kind: string) =>
        expectSqlError(
          db,
          `insert into public.email_messages (id, tenant_id, quote_id, package_id, kind, to_email_enc, to_email_hash, provider)
           values (gen_random_uuid(), $1, $2, $3, $4, 'v1.x.y', $5, 'memory')`,
          [w.tenantA, b.quoteId, b.packageId, kind, sha256Hex(randomUUID())],
        );
      expect((await insert("quote")).code).toBe(UNIQUE_VIOLATION);
      for (const kind of ["quote_resend", "quote_resend", "internal_notice"]) {
        await expect(insert(kind)).rejects.toThrow(/tuvo éxito/); // se insertó: no hubo error
      }
    });
  });

  it("el identificador del proveedor es único por proveedor", async () => {
    await withTx(db, async () => {
      const a = await base();
      const b = await base();
      await db.query(
        "update public.email_messages set provider_message_id = 'abc', status = 'sent' where id = $1",
        [a.emailId],
      );
      expect((await updEmail(b.emailId, "provider_message_id = 'abc', status = 'sent'")).code).toBe(
        UNIQUE_VIOLATION,
      );
    });
  });

  it("solo cambian el estado y lo que informa el proveedor; el resto es inmutable", async () => {
    await withTx(db, async () => {
      const b = await base();
      for (const set of [
        "to_email_enc = 'otro'",
        "to_email_hash = repeat('a', 64)",
        "kind = 'quote_resend'",
        "package_id = gen_random_uuid()",
        "share_link_id = null",
        "provider = 'resend'",
        "created_by = null",
      ]) {
        expect((await updEmail(b.emailId, set)).code, set).toBe(INSUFFICIENT_PRIVILEGE);
      }
      expect(
        (await expectSqlError(db, "delete from public.email_messages where id = $1", [b.emailId]))
          .code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("no se vacía la tabla, ni como postgres", async () => {
    await withTx(db, async () => {
      expect((await expectSqlError(db, "truncate public.email_messages cascade")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });

  it("el estado avanza pending < sent < delivered < bounced/complained y no retrocede", async () => {
    const order = ["pending", "sent", "delivered", "bounced", "complained"];
    for (const from of [...order, "failed"]) {
      for (const to of [...order, "failed"]) {
        if (from === to) continue;
        await withTx(db, async () => {
          const b = await base();
          // se lleva a `from` por un camino válido (apagando la regla solo para montar el origen)
          await db.query("alter table public.email_messages disable trigger email_messages_guard");
          await db.query(
            `update public.email_messages set status = $1,
               bounce_type = case when $1 = 'bounced' then 'hard' end where id = $2`,
            [from, b.emailId],
          );
          await db.query("alter table public.email_messages enable trigger email_messages_guard");
          const set = `status = '${to}'${to === "bounced" ? ", bounce_type = 'hard'" : ""}`;
          const attempt = updEmail(b.emailId, set);
          const rank = (s: string) =>
            ({ pending: 0, sent: 1, delivered: 2, bounced: 3, complained: 3 })[s] ?? 9;
          const allowed =
            to === "failed"
              ? from === "pending"
              : from !== "failed" && rank(from) < 3 && rank(to) > rank(from);
          if (allowed) await expect(attempt).rejects.toThrow(/tuvo éxito/);
          else expect((await attempt).code, `${from} → ${to}`).toBe(INSUFFICIENT_PRIVILEGE);
        });
      }
    }
  });

  it("el rebote exige su tipo; el código de error no admite espacios ni arrobas (nada personal)", async () => {
    await withTx(db, async () => {
      const b = await base();
      expect((await updEmail(b.emailId, "status = 'sent', error_code = 'a@b.cl'")).code).toBe(
        CHECK_VIOLATION,
      );
      expect((await updEmail(b.emailId, "status = 'sent', error_code = 'con espacio'")).code).toBe(
        CHECK_VIOLATION,
      );
      await db.query(
        "update public.email_messages set status = 'sent', error_code = 'smtp_timeout' where id = $1",
        [b.emailId],
      );
      expect((await updEmail(b.emailId, "status = 'bounced'")).code).toBe(CHECK_VIOLATION);
      expect((await updEmail(b.emailId, "status = 'delivered', bounce_type = 'hard'")).code).toBe(
        CHECK_VIOLATION,
      );
      await db.query(
        "update public.email_messages set status = 'bounced', bounce_type = 'soft', bounced_at = now() where id = $1",
        [b.emailId],
      );
    });
  });

  it("la lectura es de todos los miembros de la organización; nadie con pase escribe; B no ve nada", async () => {
    await withTx(db, async () => {
      const b = await base();
      for (const user of [w.owner, w.admin, w.sales, w.sales2, w.approver, w.viewer]) {
        await asUser(db, user, w.tenantA);
        expect(
          (await db.query("select id from public.email_messages where id = $1", [b.emailId]))
            .rowCount,
        ).toBe(1);
        await actAsPostgres(db);
      }
      await asUser(db, w.owner, w.tenantA);
      for (const sql of [
        "update public.email_messages set status = 'delivered'",
        "delete from public.email_messages",
        "insert into public.email_messages (id, tenant_id, quote_id, package_id, kind, to_email_enc, to_email_hash, provider) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'quote', 'x', repeat('a', 64), 'memory')",
      ]) {
        expect((await expectSqlError(db, sql)).code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
      await actAsPostgres(db);
      await asUser(db, w.ownerB, w.tenantB);
      expect((await db.query("select id from public.email_messages")).rowCount).toBe(0);
    });
  });

  it("un correo de A no apunta a un paquete ni a un enlace de B", async () => {
    await withTx(db, async () => {
      const a = await base();
      const bb = await base(w.tenantB, w.ownerB, w.customerB);
      const insert = (pkg: string, link: string | null) =>
        expectSqlError(
          db,
          `insert into public.email_messages (id, tenant_id, quote_id, package_id, share_link_id, kind, to_email_enc, to_email_hash, provider)
           values (gen_random_uuid(), $1, $2, $3, $4, 'quote_resend', 'x', repeat('a', 64), 'memory')`,
          [w.tenantA, a.quoteId, pkg, link],
        );
      expect((await insert(bb.packageId, null)).code).toBe(FK_VIOLATION);
      expect((await insert(a.packageId, bb.linkId)).code).toBe(FK_VIOLATION);
    });
  });
});

async function respondable(): Promise<Base> {
  const b = await base();
  await db.query("update public.quotes set status = 'sent' where id = $1", [b.quoteId]);
  return b;
}

const insertResponse = (b: Base, over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    tenant_id: w.tenantA,
    quote_id: b.quoteId,
    package_id: b.packageId,
    share_link_id: b.linkId,
    decision: "accepted",
    response_key: randomUUID(),
    acceptor_name_enc: "v1.n.n",
    reason_code: null,
    reason_text_enc: null,
    package_content_sha256: sha256Hex(b.packageId),
    acceptance_text_version: "v1",
    ip_enc: "v1.ip.ip",
    user_agent_short: "Mozilla",
    ...over,
  };
  const cols = Object.keys(row);
  return expectSqlError(
    db,
    `insert into public.quote_responses (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((c) => row[c]),
  );
};

/** Inserta sin esperar error (devuelve el id). */
async function respond(b: Base, over: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const err = await insertResponse(b, { id, ...over }).catch((e: Error) => e);
  if (err instanceof Error && /tuvo éxito/.test(err.message)) return id;
  throw new Error(`No se pudo insertar la respuesta: ${JSON.stringify(err)}`);
}

describe("quote_responses", () => {
  it("una aceptación válida se guarda; una sola respuesta por cotización (la primera gana)", async () => {
    await withTx(db, async () => {
      const b = await respondable();
      await respond(b);
      expect((await insertResponse(b)).code).toBe(UNIQUE_VIOLATION);
      expect(
        (
          await insertResponse(b, {
            decision: "rejected",
            acceptor_name_enc: null,
            acceptance_text_version: null,
            reason_code: "timing",
          })
        ).code,
      ).toBe(UNIQUE_VIOLATION);
    });
  });

  it("aceptar exige nombre y versión del texto, y no lleva motivo", async () => {
    await withTx(db, async () => {
      const b = await respondable();
      expect((await insertResponse(b, { acceptor_name_enc: null })).code).toBe(CHECK_VIOLATION);
      expect((await insertResponse(b, { acceptance_text_version: null })).code).toBe(
        CHECK_VIOLATION,
      );
      expect((await insertResponse(b, { reason_code: "timing" })).code).toBe(CHECK_VIOLATION);
      expect((await insertResponse(b, { decision: "otra" })).code).toBe(CHECK_VIOLATION);
      expect((await insertResponse(b, { package_content_sha256: "corto" })).code).toBe(
        CHECK_VIOLATION,
      );
    });
  });

  it("rechazar exige un motivo de la lista; 'otro' exige texto y los demás no lo llevan", async () => {
    await withTx(db, async () => {
      const b = await respondable();
      const reject = (over: Record<string, unknown>) =>
        insertResponse(b, {
          decision: "rejected",
          acceptor_name_enc: null,
          acceptance_text_version: null,
          ...over,
        });
      expect((await reject({ reason_code: null })).code).toBe(CHECK_VIOLATION);
      expect((await reject({ reason_code: "inventado" })).code).toBe(CHECK_VIOLATION);
      expect((await reject({ reason_code: "other" })).code).toBe(CHECK_VIOLATION);
      expect(
        (await reject({ reason_code: "price_too_high", reason_text_enc: "v1.t.t" })).code,
      ).toBe(CHECK_VIOLATION);
      expect((await reject({ reason_code: "timing", acceptor_name_enc: "v1.n.n" })).code).toBe(
        CHECK_VIOLATION,
      );
      for (const code of [
        "price_too_high",
        "not_in_budget",
        "chose_other_provider",
        "timing",
        "no_longer_needed",
      ]) {
        await db.query("savepoint r");
        await respond(b, {
          decision: "rejected",
          acceptor_name_enc: null,
          acceptance_text_version: null,
          reason_code: code,
        });
        await db.query("rollback to savepoint r");
      }
      await respond(b, {
        decision: "rejected",
        acceptor_name_enc: null,
        acceptance_text_version: null,
        reason_code: "other",
        reason_text_enc: "v1.t.t",
      });
    });
  });

  it("solo agregar: no se edita ni se borra, ni como postgres", async () => {
    await withTx(db, async () => {
      const b = await respondable();
      const id = await respond(b);
      for (const sql of [
        "update public.quote_responses set decision = 'rejected' where id = $1",
        "update public.quote_responses set acceptor_name_enc = 'otro' where id = $1",
        "delete from public.quote_responses where id = $1",
      ]) {
        expect((await expectSqlError(db, sql, [id])).code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });
    await withTx(db, async () => {
      expect((await expectSqlError(db, "truncate public.quote_responses cascade")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });

  it("una respuesta de A no apunta a un paquete ni a un enlace de B", async () => {
    await withTx(db, async () => {
      const a = await respondable();
      const bb = await base(w.tenantB, w.ownerB, w.customerB);
      expect((await insertResponse(a, { package_id: bb.packageId })).code).toBe(FK_VIOLATION);
      expect((await insertResponse(a, { share_link_id: bb.linkId })).code).toBe(FK_VIOLATION);
    });
  });

  it("los miembros leen la respuesta pero ningún pase lee ip_enc ni user_agent_short; nadie con pase escribe", async () => {
    await withTx(db, async () => {
      const b = await respondable();
      const id = await respond(b);
      for (const user of [w.owner, w.sales, w.viewer, w.approver]) {
        await asUser(db, user, w.tenantA);
        const { rows } = await db.query(
          "select decision, acceptor_name_enc, responded_at from public.quote_responses where id = $1",
          [id],
        );
        expect(rows).toHaveLength(1);
        for (const col of ["ip_enc", "user_agent_short", "*"]) {
          expect(
            (await expectSqlError(db, `select ${col} from public.quote_responses`)).code,
            col,
          ).toBe(INSUFFICIENT_PRIVILEGE);
        }
        await actAsPostgres(db);
      }
      await asUser(db, w.owner, w.tenantA);
      for (const sql of [
        "update public.quote_responses set decision = 'rejected'",
        "delete from public.quote_responses",
        `insert into public.quote_responses (id, tenant_id, quote_id, package_id, share_link_id, decision, response_key, package_content_sha256)
         values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'rejected', gen_random_uuid(), repeat('a', 64))`,
      ]) {
        expect((await expectSqlError(db, sql)).code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
      await actAsPostgres(db);
      await asUser(db, w.ownerB, w.tenantB);
      expect((await db.query("select id from public.quote_responses")).rowCount).toBe(0);
    });
  });
});
