// Cobro por transferencia (H-050 a H-057): lo que protege el dinero y el aislamiento. Quién ve y cambia los datos bancarios, quién
// marca pagos, cómo se calculan los hitos al aceptar (enteros, el peso sobrante al saldo) y que los datos bancarios no aparezcan
// antes de aceptar. Todo ficticio; cada prueba corre dentro de una transacción que se deshace.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsPostgres, connect, expectSqlError, withTx, type TestUser } from "./helpers";
import {
  actAsService,
  asUser,
  buildWorld,
  createQuote,
  sendQuoteAs,
  type SentQuote,
  type World,
} from "./send-helpers";

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

async function as<T = Json>(user: TestUser, sql: string, params: unknown[] = [], tenant?: string) {
  await asUser(db, user, tenant ?? w.tenantA);
  const { rows } = await db.query<{ r: T }>(sql, params);
  await actAsPostgres(db);
  return rows[0]?.r;
}
async function asError(user: TestUser, sql: string, params: unknown[] = [], tenant?: string) {
  await asUser(db, user, tenant ?? w.tenantA);
  const err = await expectSqlError(db, sql, params);
  await actAsPostgres(db);
  return err;
}
async function rows<T = Json>(
  user: TestUser,
  sql: string,
  params: unknown[] = [],
  tenant?: string,
) {
  await asUser(db, user, tenant ?? w.tenantA);
  const result = await db.query<T & Json>(sql, params);
  await actAsPostgres(db);
  return result.rows;
}
async function service<T = Json>(sql: string, params: unknown[]): Promise<T> {
  await actAsService(db);
  const { rows: r } = await db.query<{ r: T }>(sql, params);
  await actAsPostgres(db);
  return r[0].r;
}

const SET_BANK = "select public.set_bank_account($1, $2, $3, $4) as r";
const BANK_ENC = `v1.${"b".repeat(16)}.${"c".repeat(80)}`;

async function addBank(user: TestUser = w.owner): Promise<string> {
  const id = randomUUID();
  await as(user, SET_BANK, [id, BANK_ENC, "6789", 0]);
  return id;
}

async function milestones(quoteId: string) {
  const { rows: r } = await db.query<{
    seq: number;
    kind: string;
    amount_clp: string;
    status: string;
  }>(
    "select seq, kind, amount_clp, status from public.payment_milestones where quote_id = $1 order by seq",
    [quoteId],
  );
  return r.map((m) => ({ ...m, amount_clp: Number(m.amount_clp) }));
}
async function quoteStatus(quoteId: string): Promise<string> {
  const { rows: r } = await db.query<{ status: string }>(
    "select status from public.quotes where id = $1",
    [quoteId],
  );
  return r[0].status;
}
async function milestoneId(quoteId: string, seq: number): Promise<string> {
  const { rows: r } = await db.query<{ id: string }>(
    "select id from public.payment_milestones where quote_id = $1 and seq = $2",
    [quoteId, seq],
  );
  return r[0].id;
}

/** Envía una cotización del Comercial, le fija la condición de pago y el cliente la acepta (con el disparador ya corrido). */
async function acceptWith(
  terms: "full" | "split_50_50" | null,
  oddTotal = false,
): Promise<SentQuote> {
  const q = await sendQuoteAs(db, w.sales, w.tenantA, w.customerA);
  await actAsPostgres(db);
  await db.query("update public.quotes set payment_terms = $2 where id = $1", [q.quoteId, terms]);
  if (oddTotal) {
    await db.query(
      "update public.quotes set tax_clp = tax_clp + 1, total_clp = total_clp + 1 where id = $1",
      [q.quoteId],
    );
  }
  const r = await service<Json>(
    "select public.share_link_respond($1, $2, $3, 'accepted', 'v1.nombre.cifrado', null, null, null, null, null, 'v1') as r",
    [q.sha, randomUUID(), randomUUID()],
  );
  expect(r.result).toBe("ok");
  await db.query("set constraints all immediate");
  return q;
}

const RECORD = "select public.record_payment($1, current_date, $2, null) as r";

describe("H-050 · datos de transferencia", () => {
  it("solo el Dueño y el Administrador los ven y los cambian; otra organización no los ve", async () => {
    await withTx(db, async () => {
      expect((await asError(w.sales, SET_BANK, [randomUUID(), BANK_ENC, "1234", 0])).code).toBe(
        "42501",
      );
      expect((await asError(w.approver, SET_BANK, [randomUUID(), BANK_ENC, "1234", 0])).code).toBe(
        "42501",
      );
      expect((await asError(w.viewer, SET_BANK, [randomUUID(), BANK_ENC, "1234", 0])).code).toBe(
        "42501",
      );
      const id = await addBank(w.owner);

      const select = "select id, details_enc from public.bank_accounts";
      expect(await rows(w.owner, select)).toHaveLength(1);
      expect(await rows(w.admin, select)).toHaveLength(1);
      for (const user of [w.sales, w.approver, w.viewer])
        expect(await rows(user, select)).toHaveLength(0);
      expect(await rows(w.ownerB, select, [], w.tenantB)).toHaveLength(0);
      // Ni con la cabecera de A: no es miembro
      expect(await rows(w.ownerB, select, [], w.tenantA)).toHaveLength(0);

      // Cambiar: con la revisión que se vio; una vieja choca
      const changed = await as<Json>(w.admin, SET_BANK, [id, BANK_ENC, "4321", 1]);
      expect(changed).toMatchObject({ id, revision: 2 });
      expect((await asError(w.owner, SET_BANK, [id, BANK_ENC, "0000", 1])).code).toBe("CP409");
      // Otra organización no puede escribir sobre la de A con la cabecera de A
      expect((await asError(w.ownerB, SET_BANK, [id, BANK_ENC, "0000", 2], w.tenantA)).code).toBe(
        "42501",
      );

      // Cada cambio queda en la auditoría, con los últimos 4 y sin lo cifrado
      const { rows: audit } = await db.query<{
        action: string;
        details: Json;
        actor_user_id: string;
      }>(
        "select action, details, actor_user_id from public.audit_log where tenant_id = $1 and resource_id = $2 order by id",
        [w.tenantA, id],
      );
      expect(audit.map((a) => a.action)).toEqual(["bank_account.created", "bank_account.changed"]);
      expect(audit[1]).toMatchObject({
        actor_user_id: w.admin.id,
        details: { account_last4_before: "6789", account_last4: "4321" },
      });
      expect(JSON.stringify(audit)).not.toContain(BANK_ENC);

      // Nadie escribe la tabla directo
      expect(
        (await asError(w.owner, "update public.bank_accounts set account_last4 = '0000'")).code,
      ).toBe("42501");
    });
  });
});

describe("H-052 · condición de pago del borrador", () => {
  it("sin cuenta no se puede fijar; la fija solo el autor y solo en borrador", async () => {
    await withTx(db, async () => {
      const quoteId = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const SET = "select public.set_quote_payment_terms($1, $2) as r";
      const noBank = await asError(w.sales, SET, [quoteId, "full"]);
      expect(noBank.code).toBe("CP422");
      expect(noBank.message).toMatch(/no_bank_account/);
      await addBank();
      expect(await as(w.sales, SET, [quoteId, "split_50_50"])).toMatchObject({
        payment_terms: "split_50_50",
      });
      expect((await asError(w.sales2, SET, [quoteId, "full"])).code).toBe("42501");
      expect((await asError(w.owner, SET, [quoteId, "full"])).code).toBe("42501");
      expect((await asError(w.sales, SET, [quoteId, "30_70"])).code).toBe("CP422");
      // Sin condición siempre se puede (envío sin cobro)
      expect(await as(w.sales, SET, [quoteId, null])).toMatchObject({ payment_terms: null });
    });
  });
});

describe("H-053 · al aceptar", () => {
  it("50/50 con total impar: hitos enteros, el peso sobrante al saldo, la cuenta congelada y «Pendiente de anticipo»", async () => {
    await withTx(db, async () => {
      await addBank();
      const q = await acceptWith("split_50_50", true);
      const { rows: total } = await db.query<{ total_clp: string }>(
        "select total_clp from public.quotes where id = $1",
        [q.quoteId],
      );
      const t = Number(total[0].total_clp);
      expect(t % 2).toBe(1);
      const ms = await milestones(q.quoteId);
      expect(ms).toEqual([
        { seq: 1, kind: "deposit", amount_clp: Math.floor(t / 2), status: "pending" },
        { seq: 2, kind: "balance", amount_clp: t - Math.floor(t / 2), status: "pending" },
      ]);
      expect(ms[0].amount_clp + ms[1].amount_clp).toBe(t);
      expect(await quoteStatus(q.quoteId)).toBe("pending_deposit");

      const { rows: frozen } = await db.query<{ details_enc: string; bank_revision: number }>(
        "select details_enc, bank_revision from public.quote_payment_accounts where quote_id = $1",
        [q.quoteId],
      );
      expect(frozen).toEqual([{ details_enc: BANK_ENC, bank_revision: 1 }]);
      // La copia congelada solo la leen quienes manejan la cuenta
      const frozenSelect = "select quote_id from public.quote_payment_accounts";
      expect(await rows(w.admin, frozenSelect)).toHaveLength(1);
      expect(await rows(w.sales, frozenSelect)).toHaveLength(0);
      // Los hitos los ve todo miembro de A, nadie de B
      const msSelect = "select id from public.payment_milestones";
      expect(await rows(w.viewer, msSelect)).toHaveLength(2);
      expect(await rows(w.ownerB, msSelect, [], w.tenantB)).toHaveLength(0);

      // Ya aceptada, el enlace entrega el monto y la cuenta congelada
      const payment = await service<Json>("select public.share_link_payment($1) as r", [q.sha]);
      expect(payment).toMatchObject({ tenant_id: w.tenantA, payment_terms: "split_50_50" });
      expect((payment.bank as Json).details_enc).toBe(BANK_ENC);
    });
  });

  it("antes de aceptar, el enlace no entrega nada para pagar (ni con condición y cuenta)", async () => {
    await withTx(db, async () => {
      await addBank();
      const q = await sendQuoteAs(db, w.sales, w.tenantA, w.customerA);
      await db.query("update public.quotes set payment_terms = 'full' where id = $1", [q.quoteId]);
      expect(await service("select public.share_link_payment($1) as r", [q.sha])).toBeNull();
      expect(await milestones(q.quoteId)).toEqual([]);
    });
  });

  it("sin condición de pago (cotizaciones de antes del cobro): aceptar no crea hitos ni cambia el estado", async () => {
    await withTx(db, async () => {
      await addBank();
      const q = await acceptWith(null);
      expect(await milestones(q.quoteId)).toEqual([]);
      expect(await quoteStatus(q.quoteId)).toBe("accepted");
      expect(await service("select public.share_link_payment($1) as r", [q.sha])).toBeNull();
    });
  });
});

describe("H-054, H-055 y H-056 · marcar, deshacer y pedir el saldo", () => {
  it("solo el Dueño y el Administrador marcan; el saldo después del anticipo; estados de §7; se deshace en orden", async () => {
    await withTx(db, async () => {
      await addBank();
      const q = await acceptWith("split_50_50");
      const [deposit, balance] = [await milestoneId(q.quoteId, 1), await milestoneId(q.quoteId, 2)];

      for (const user of [w.sales, w.approver, w.viewer]) {
        expect((await asError(user, RECORD, [deposit, 1])).code).toBe("42501");
      }
      expect((await asError(w.ownerB, RECORD, [deposit, 1], w.tenantA)).code).toBe("42501");
      expect((await asError(w.admin, RECORD, [balance, 1])).message).toMatch(/deposit_first/);
      // El saldo no se pide sin anticipo
      expect(
        (await asError(w.sales, "select public.request_second_payment($1) as r", [balance]))
          .message,
      ).toMatch(/deposit_not_paid/);

      await as(w.admin, RECORD, [deposit, 5950]);
      expect(await quoteStatus(q.quoteId)).toBe("deposit_paid");

      // Pedir el saldo: el autor (Comercial) sí; otro Comercial no
      const REQUEST = "select public.request_second_payment($1) as r";
      expect((await asError(w.sales2, REQUEST, [balance])).code).toBe("42501");
      const requested = await as<Json>(w.sales, REQUEST, [balance]);
      expect(requested).toMatchObject({ first_request: true, milestone_id: balance });
      expect((requested.context as Json).bank).toMatchObject({
        details_enc: BANK_ENC,
        changed: false,
      });
      expect(await quoteStatus(q.quoteId)).toBe("pending_balance");
      // Repetirla no cambia nada (sirve para reenviar el correo)
      expect(await as<Json>(w.owner, REQUEST, [balance])).toMatchObject({ first_request: false });

      await as(w.owner, RECORD, [balance, 5950]);
      expect(await quoteStatus(q.quoteId)).toBe("paid");

      // Deshacer: con motivo, en orden y solo quien confirma pagos
      const REVERSE = "select public.reverse_payment($1, $2) as r";
      expect((await asError(w.sales, REVERSE, [balance, "error de digitación"])).code).toBe(
        "42501",
      );
      expect((await asError(w.admin, REVERSE, [deposit, "error de digitación"])).message).toMatch(
        /reverse_balance_first/,
      );
      expect((await asError(w.admin, REVERSE, [balance, ""])).code).toBe("CP422");
      await as(w.admin, REVERSE, [balance, "era de otro cliente"]);
      expect(await quoteStatus(q.quoteId)).toBe("pending_balance");
      const ms = await milestones(q.quoteId);
      expect(ms.map((m) => m.status)).toEqual(["paid", "requested"]);

      // El registro original no se borra: la línea de tiempo tiene el pago y la reversión con su motivo
      const { rows: events } = await db.query<{ type: string; data: Json }>(
        "select type, data from public.quote_events where quote_id = $1 order by id",
        [q.quoteId],
      );
      const types = events.map((e) => e.type);
      expect(types.indexOf("accepted")).toBeLessThan(types.indexOf("payment_pending"));
      expect(types.filter((t) => t === "payment_recorded")).toHaveLength(2);
      expect(events.find((e) => e.type === "payment_reversed")?.data).toMatchObject({
        seq: 2,
        reason: "era de otro cliente",
      });
    });
  });

  it("100 %: un solo hito, «Pendiente de pago» y luego «Pagada»", async () => {
    await withTx(db, async () => {
      await addBank();
      const q = await acceptWith("full");
      const ms = await milestones(q.quoteId);
      expect(ms).toHaveLength(1);
      expect(ms[0].kind).toBe("full");
      expect(await quoteStatus(q.quoteId)).toBe("pending_payment");
      await as(w.owner, RECORD, [await milestoneId(q.quoteId, 1), ms[0].amount_clp]);
      expect(await quoteStatus(q.quoteId)).toBe("paid");
    });
  });
});
