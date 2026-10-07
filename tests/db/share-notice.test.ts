// Sprint 3 · migración 27 · el aviso interno de la respuesta del cliente (H-031, hallazgos B-1 e I-4):
// la base entrega los destinatarios ya filtrados (el autor solo si sigue activo; si no, el Dueño y los
// Administradores activos) y deja el aviso anotado en email_messages. Cada prueba corre en una
// transacción que se deshace.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import {
  actAsService,
  asUser,
  buildWorld,
  sendQuoteAs,
  sha256Hex,
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

type Json = Record<string, unknown>;
type Recipients = {
  package_id: string;
  audience: "author" | "managers";
  recipients: { user_id: string; email: string }[];
};

async function asServer<T = Json>(sql: string, params: unknown[]): Promise<T> {
  await actAsService(setup);
  const { rows } = await setup.query<{ r: T }>(sql, params);
  await actAsPostgres(setup);
  return rows[0].r;
}

const RESPOND_SQL =
  "select public.share_link_respond($1, $2, $3, 'accepted', 'v1.nombre.cifrado', null, null, 'v1.ip.ip', null, 'Mozilla', 'v1') as r";

/** Una cotización de `sales` enviada y ya aceptada por el cliente. */
async function respondedQuote() {
  const q = await sendQuoteAs(setup, w.sales, w.tenantA, w.customerA);
  const responseId = randomUUID();
  const result = await asServer<Json>(RESPOND_SQL, [q.sha, responseId, randomUUID()]);
  expect(result).toMatchObject({ result: "ok" });
  return { ...q, responseId };
}

const recipientsOf = (tenantId: string, quoteId: string, responseId: string) =>
  asServer<Recipients>("select public.share_notice_recipients($1, $2, $3) as r", [
    tenantId,
    quoteId,
    responseId,
  ]);

const removeMember = async (userId: string) => {
  await actAsPostgres(setup);
  await setup.query(
    "update public.members set status = 'removed', removed_at = now() where tenant_id = $1 and user_id = $2",
    [w.tenantA, userId],
  );
};

describe("a quién se avisa (B-1)", () => {
  it("autor activo: el aviso es solo para él", async () => {
    await withTx(setup, async () => {
      const q = await respondedQuote();
      const result = await recipientsOf(w.tenantA, q.quoteId, q.responseId);
      expect(result.audience).toBe("author");
      expect(result.package_id).toBe(q.packageId);
      expect(result.recipients).toEqual([{ user_id: w.sales.id, email: w.sales.email }]);
    });
  });

  it("autor quitado del equipo: NO le llega; va al Dueño y a los Administradores activos", async () => {
    await withTx(setup, async () => {
      const q = await respondedQuote();
      await removeMember(w.sales.id);
      const result = await recipientsOf(w.tenantA, q.quoteId, q.responseId);
      expect(result.audience).toBe("managers");
      const emails = result.recipients.map((r) => r.email).sort();
      expect(emails).toEqual([w.admin.email, w.owner.email].sort());
      expect(emails).not.toContain(w.sales.email);
      // ni el aprobador, ni el observador, ni el otro comercial
      for (const other of [w.approver, w.viewer, w.sales2])
        expect(emails).not.toContain(other.email);
    });
  });

  it("autor quitado y un Administrador también quitado: solo queda el Dueño", async () => {
    await withTx(setup, async () => {
      const q = await respondedQuote();
      await removeMember(w.sales.id);
      await removeMember(w.admin.id);
      const result = await recipientsOf(w.tenantA, q.quoteId, q.responseId);
      expect(result.recipients).toEqual([{ user_id: w.owner.id, email: w.owner.email }]);
    });
  });

  it("nunca entrega a alguien de otra organización", async () => {
    await withTx(setup, async () => {
      const q = await respondedQuote();
      await removeMember(w.sales.id);
      const result = await recipientsOf(w.tenantA, q.quoteId, q.responseId);
      expect(result.recipients.map((r) => r.user_id)).not.toContain(w.ownerB.id);
    });
  });

  it("la respuesta tiene que ser de ESA organización y ESA cotización", async () => {
    await withTx(setup, async () => {
      const q = await respondedQuote();
      await actAsService(setup);
      const crossTenant = await expectSqlError(
        setup,
        "select public.share_notice_recipients($1, $2, $3)",
        [w.tenantB, q.quoteId, q.responseId],
      );
      expect(crossTenant.code).toBe("CP404");
      const crossQuote = await expectSqlError(
        setup,
        "select public.share_notice_recipients($1, $2, $3)",
        [w.tenantA, randomUUID(), q.responseId],
      );
      expect(crossQuote.code).toBe("CP404");
      const unknown = await expectSqlError(
        setup,
        "select public.share_notice_recipients($1, $2, $3)",
        [w.tenantA, q.quoteId, randomUUID()],
      );
      expect(unknown.code).toBe("CP404");
    });
  });

  it("un miembro con pase no puede pedir los destinatarios", async () => {
    await withTx(setup, async () => {
      const q = await respondedQuote();
      await asUser(setup, w.owner, w.tenantA);
      const error = await expectSqlError(
        setup,
        "select public.share_notice_recipients($1, $2, $3)",
        [w.tenantA, q.quoteId, q.responseId],
      );
      expect(error.code).toBe("42501");
    });
  });
});

describe("el aviso queda anotado (I-4)", () => {
  const REGISTER =
    "select public.internal_notice_register($1, $2, $3, $4, $5, 'v1.correo.cifrado', $6) as r";
  const HASH = sha256Hex("autor@ejemplo.test");

  const row = async (emailId: string) => {
    await actAsPostgres(setup);
    const { rows } = await setup.query<Json>("select * from public.email_messages where id = $1", [
      emailId,
    ]);
    return rows[0];
  };

  it("registra el aviso con el paquete, sin enlace del cliente, pendiente", async () => {
    await withTx(setup, async () => {
      const q = await respondedQuote();
      const emailId = randomUUID();
      await asServer(REGISTER, [emailId, w.tenantA, q.quoteId, q.responseId, w.sales.id, HASH]);
      expect(await row(emailId)).toMatchObject({
        kind: "internal_notice",
        package_id: q.packageId,
        share_link_id: null,
        status: "pending",
        provider: "pending",
        quote_id: q.quoteId,
      });
    });
  });

  it("repetir el mismo registro no duplica", async () => {
    await withTx(setup, async () => {
      const q = await respondedQuote();
      const emailId = randomUUID();
      const args = [emailId, w.tenantA, q.quoteId, q.responseId, w.sales.id, HASH];
      await asServer(REGISTER, args);
      await asServer(REGISTER, args);
      await actAsPostgres(setup);
      const { rows } = await setup.query(
        "select 1 from public.email_messages where quote_id = $1 and kind = 'internal_notice'",
        [q.quoteId],
      );
      expect(rows).toHaveLength(1);
    });
  });

  it("se niega a anotar un aviso para quien ya no es miembro, o para otra organización", async () => {
    await withTx(setup, async () => {
      const q = await respondedQuote();
      await removeMember(w.sales.id);
      await actAsService(setup);
      const removed = await expectSqlError(setup, REGISTER, [
        randomUUID(),
        w.tenantA,
        q.quoteId,
        q.responseId,
        w.sales.id,
        HASH,
      ]);
      expect(removed.code).toBe("42501");
      const outsider = await expectSqlError(setup, REGISTER, [
        randomUUID(),
        w.tenantA,
        q.quoteId,
        q.responseId,
        w.ownerB.id,
        HASH,
      ]);
      expect(outsider.code).toBe("42501");
      const crossTenant = await expectSqlError(setup, REGISTER, [
        randomUUID(),
        w.tenantB,
        q.quoteId,
        q.responseId,
        w.ownerB.id,
        HASH,
      ]);
      expect(crossTenant.code).toBe("CP404");
      const badHash = await expectSqlError(setup, REGISTER, [
        randomUUID(),
        w.tenantA,
        q.quoteId,
        q.responseId,
        w.owner.id,
        "no-es-huella",
      ]);
      expect(badHash.code).toBe("CP422");
    });
  });

  const SETTLE = "select public.internal_notice_settle($1, $2, $3, $4, $5) as r";

  async function registered() {
    const q = await respondedQuote();
    const emailId = randomUUID();
    await asServer(REGISTER, [emailId, w.tenantA, q.quoteId, q.responseId, w.sales.id, HASH]);
    return { q, emailId };
  }

  it("enviado: queda con el proveedor y su identificador; repetir no cambia nada", async () => {
    await withTx(setup, async () => {
      const { emailId } = await registered();
      expect(await asServer(SETTLE, [emailId, w.tenantA, "mailpit", "m-1", null])).toEqual({
        status: "sent",
      });
      expect(await row(emailId)).toMatchObject({
        status: "sent",
        provider: "mailpit",
        provider_message_id: "m-1",
      });
      expect(await asServer(SETTLE, [emailId, w.tenantA, "mailpit", "m-1", null])).toEqual({
        status: "already_settled",
      });
    });
  });

  it("fallido: queda con su código y sin identificador de proveedor", async () => {
    await withTx(setup, async () => {
      const { emailId } = await registered();
      expect(await asServer(SETTLE, [emailId, w.tenantA, null, null, "timeout"])).toEqual({
        status: "failed",
      });
      expect(await row(emailId)).toMatchObject({
        status: "failed",
        error_code: "timeout",
        provider_message_id: null,
      });
    });
  });

  it("no cierra correos de otro tipo, de otra organización ni con un código con datos personales", async () => {
    await withTx(setup, async () => {
      const { emailId } = await registered();
      const q2 = await sendQuoteAs(setup, w.sales2, w.tenantA, w.customerA);
      await actAsService(setup);
      const quoteMail = await expectSqlError(setup, SETTLE, [
        q2.emailId,
        w.tenantA,
        null,
        null,
        "timeout",
      ]);
      expect(quoteMail.code).toBe("CP404");
      const otherTenant = await expectSqlError(setup, SETTLE, [
        emailId,
        w.tenantB,
        null,
        null,
        "timeout",
      ]);
      expect(otherTenant.code).toBe("CP404");
      const personalData = await expectSqlError(setup, SETTLE, [
        emailId,
        w.tenantA,
        null,
        null,
        "fallo con ana@ejemplo.test",
      ]);
      expect(personalData.code).toBe("CP422");
    });
  });

  it("un miembro con pase ve el aviso de su organización, y solo de la suya", async () => {
    await withTx(setup, async () => {
      const { emailId } = await registered();
      await asUser(setup, w.owner, w.tenantA);
      const own = await setup.query("select kind from public.email_messages where id = $1", [
        emailId,
      ]);
      expect(own.rows).toEqual([{ kind: "internal_notice" }]);
      await asUser(setup, w.ownerB, w.tenantB);
      const other = await setup.query("select kind from public.email_messages where id = $1", [
        emailId,
      ]);
      expect(other.rows).toEqual([]);
    });
  });
});
