// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · migración 20261110120000 · el control en el envío (H-040b): `prepare_quote_send` rechaza la cotización si la regla de
// aprobación de la organización la pide, y anota qué versión de la regla regía. Cubre: «Nunca» deja pasar y anota la versión;
// «Siempre» rechaza (CP423 `approval_required`) sin dejar paquete, enlace, correo ni candado; el umbral exacto pasa y un peso
// más se bloquea; vale para TODOS los que envían (también Dueño y Administrador); el reenvío de lo ya enviado sigue
// funcionando; el campo del paquete no se inventa ni se cambia; la regla que falta rechaza; y, con dos conexiones, la regla
// que cambia justo antes de enviar (y el envío en curso que retrasa el cambio de regla). Todo es ficticio.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actAsPostgres,
  connect,
  createTenantAs,
  createUser,
  expectSqlError,
  withTx,
  type TestUser,
} from "./helpers";
import {
  PREPARE_SQL,
  createQuoteWith,
  prepareArgs,
  prepareIds,
  sendFootprint,
  type QuoteSpec,
} from "./approval-helpers";
import {
  asUser,
  buildWorld,
  insertPackage,
  newToken,
  sendQuoteAs,
  sha256Hex,
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

const LOCKED = "CP423";
const SET = "select public.set_approval_rule($1, $2, $3, $4) as r";

async function setRule(
  client: Client,
  user: TestUser,
  tenant: string,
  expected: number,
  mode: string,
  amount: number | null = null,
  discount: number | null = null,
) {
  await asUser(client, user, tenant);
  await client.query(SET, [expected, mode, amount, discount]);
  await actAsPostgres(client);
}

/** Envía como `user` y devuelve el resultado o el error. */
async function tryPrepare(
  client: Client,
  user: TestUser,
  tenant: string,
  quoteId: string,
  revision: number,
) {
  const ids = prepareIds();
  await asUser(client, user, tenant);
  const error = await expectSqlError(
    client,
    PREPARE_SQL,
    prepareArgs(quoteId, revision, ids),
  ).catch(() => null);
  return { ids, error };
}

async function prepareOk(
  client: Client,
  user: TestUser,
  tenant: string,
  quoteId: string,
  revision: number,
) {
  const ids = prepareIds();
  await asUser(client, user, tenant);
  const { rows } = await client.query<{ r: Record<string, unknown> }>(
    PREPARE_SQL,
    prepareArgs(quoteId, revision, ids),
  );
  await actAsPostgres(client);
  return { ids, result: rows[0].r };
}

const plain = (price: number): QuoteSpec => ({ lines: [{ price }] });

describe("con «Nunca» (la regla de siempre) todo sale como hoy", () => {
  it("el envío pasa y el paquete anota la versión 1 de la regla", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await createQuoteWith(
        db,
        w.sales,
        w.tenantA,
        w.customerA,
        plain(50_000),
      );
      const { ids, result } = await prepareOk(db, w.sales, w.tenantA, quoteId, revision);
      expect(result.status).toBe("prepared");
      const { rows } = await db.query(
        `select p.approval_rule_id, r.version, r.mode, r.tenant_id
           from public.quote_packages p
           join public.approval_rules r on r.tenant_id = p.tenant_id and r.id = p.approval_rule_id
          where p.id = $1`,
        [ids.packageId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ version: 1, mode: "never", tenant_id: w.tenantA });
    });
  });

  it("anota la versión que regía en ese momento (la 3), no la primera", async () => {
    await withTx(db, async () => {
      await setRule(db, w.owner, w.tenantA, 1, "always");
      await setRule(db, w.owner, w.tenantA, 2, "conditional", 5_000_000, null);
      const { quoteId, revision } = await createQuoteWith(
        db,
        w.sales,
        w.tenantA,
        w.customerA,
        plain(50_000),
      );
      const { ids } = await prepareOk(db, w.sales, w.tenantA, quoteId, revision);
      const { rows } = await db.query(
        `select r.version from public.quote_packages p
           join public.approval_rules r on r.tenant_id = p.tenant_id and r.id = p.approval_rule_id where p.id = $1`,
        [ids.packageId],
      );
      expect(rows[0].version).toBe(3);
    });
  });
});

describe("con «Siempre» el envío se rechaza y no deja nada a medias", () => {
  it("CP423 approval_required: sin paquete, sin enlace, sin correo y sin candado", async () => {
    await withTx(db, async () => {
      await setRule(db, w.owner, w.tenantA, 1, "always");
      const { quoteId, revision } = await createQuoteWith(
        db,
        w.sales,
        w.tenantA,
        w.customerA,
        plain(50_000),
      );
      const { error } = await tryPrepare(db, w.sales, w.tenantA, quoteId, revision);
      expect(error?.code).toBe(LOCKED);
      expect(error?.message).toBe("approval_required");
      const footprint = await sendFootprint(db, w.tenantA, quoteId);
      expect(footprint).toEqual({ packages: 0, links: 0, emails: 0, locked: false });
      // la cotización sigue en borrador y se puede editar
      await actAsPostgres(db);
      const { rows } = await db.query("select status, revision from public.quotes where id = $1", [
        quoteId,
      ]);
      expect(rows[0]).toMatchObject({ status: "draft", revision });
    });
  });

  it("vale para TODOS los que envían: también el Dueño y el Administrador (decisión 15)", async () => {
    await withTx(db, async () => {
      await setRule(db, w.owner, w.tenantA, 1, "always");
      for (const user of [w.owner, w.admin, w.sales, w.sales2]) {
        const { quoteId, revision } = await createQuoteWith(
          db,
          user,
          w.tenantA,
          w.customerA,
          plain(10_000),
        );
        const { error } = await tryPrepare(db, user, w.tenantA, quoteId, revision);
        expect(error?.code, user.id).toBe(LOCKED);
        expect(error?.message, user.id).toBe("approval_required");
      }
    });
  });

  it("el error trae los motivos en `detail`, para quien los quiera leer", async () => {
    await withTx(db, async () => {
      await setRule(db, w.owner, w.tenantA, 1, "conditional", 1_000, 0);
      const { quoteId, revision } = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, {
        lines: [{ price: 50_000, discount: { kind: "percent", bp: 500 } }],
      });
      const ids = prepareIds();
      await asUser(db, w.sales, w.tenantA);
      await db.query("savepoint s");
      try {
        await db.query(PREPARE_SQL, prepareArgs(quoteId, revision, ids));
        throw new Error("debía rechazar");
      } catch (e) {
        await db.query("rollback to savepoint s");
        expect((e as { detail?: string }).detail).toBe("amount,discount");
      }
    });
  });

  it("la regla de OTRA organización no bloquea los envíos de esta", async () => {
    await withTx(db, async () => {
      await setRule(db, w.ownerB, w.tenantB, 1, "always");
      const { quoteId, revision } = await createQuoteWith(
        db,
        w.sales,
        w.tenantA,
        w.customerA,
        plain(50_000),
      );
      const { result } = await prepareOk(db, w.sales, w.tenantA, quoteId, revision);
      expect(result.status).toBe("prepared");
    });
  });
});

describe("según el monto y el descuento", () => {
  it("el umbral exacto pasa y un peso más se bloquea (el total incluye IVA)", async () => {
    await withTx(db, async () => {
      await setRule(db, w.owner, w.tenantA, 1, "conditional", 2_000_000, null);
      // neto 1.680.672 → IVA 319.328 → total 2.000.000; neto 1.680.673 → total 2.000.001
      const exact = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, plain(1_680_672));
      expect(exact.totals.totalClp).toBe(2_000_000);
      const over = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, plain(1_680_673));
      expect(over.totals.totalClp).toBe(2_000_001);

      const passes = await prepareOk(db, w.sales, w.tenantA, exact.quoteId, exact.revision);
      expect(passes.result.status).toBe("prepared");
      const blocked = await tryPrepare(db, w.sales, w.tenantA, over.quoteId, over.revision);
      expect(blocked.error?.code).toBe(LOCKED);
      expect(blocked.error?.message).toBe("approval_required");
      expect(await sendFootprint(db, w.tenantA, over.quoteId)).toEqual({
        packages: 0,
        links: 0,
        emails: 0,
        locked: false,
      });
    });
  });

  it("el descuento: 10 % exacto pasa, 10,01 % se bloquea; el umbral 0 pide ante cualquier descuento", async () => {
    await withTx(db, async () => {
      await setRule(db, w.owner, w.tenantA, 1, "conditional", null, 1_000);
      const exact = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, {
        lines: [{ price: 1_000_000, discount: { kind: "percent", bp: 1_000 } }],
      });
      const over = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, {
        lines: [{ price: 1_000_000, discount: { kind: "amount", clp: 100_100 } }],
      });
      expect(
        (await prepareOk(db, w.sales, w.tenantA, exact.quoteId, exact.revision)).result.status,
      ).toBe("prepared");
      expect(
        (await tryPrepare(db, w.sales, w.tenantA, over.quoteId, over.revision)).error?.code,
      ).toBe(LOCKED);

      await setRule(db, w.owner, w.tenantA, 2, "conditional", null, 0);
      const none = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, plain(1_000_000));
      const tiny = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, {
        lines: [{ price: 1_000_000, discount: { kind: "amount", clp: 1 } }],
      });
      expect(
        (await prepareOk(db, w.sales, w.tenantA, none.quoteId, none.revision)).result.status,
      ).toBe("prepared");
      expect(
        (await tryPrepare(db, w.sales, w.tenantA, tiny.quoteId, tiny.revision)).error?.code,
      ).toBe(LOCKED);
    });
  });

  it("línea 6 % más general 5 % (efectivo 10,7 %) se bloquea con umbral 10 %", async () => {
    await withTx(db, async () => {
      await setRule(db, w.owner, w.tenantA, 1, "conditional", null, 1_000);
      const q = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, {
        lines: [{ price: 1_000_000, discount: { kind: "percent", bp: 600 } }],
        globalDiscount: { kind: "percent", bp: 500 },
      });
      expect((await tryPrepare(db, w.sales, w.tenantA, q.quoteId, q.revision)).error?.message).toBe(
        "approval_required",
      );
    });
  });
});

describe("lo ya enviado no se vuelve a evaluar", () => {
  it("el reenvío sigue funcionando después de cambiar la regla a «Siempre»", async () => {
    await withTx(db, async () => {
      // Se envía de punta a punta por las funciones reales, con la regla «Nunca».
      const sent = await sendQuoteAs(db, w.sales, w.tenantA, w.customerA);
      await setRule(db, w.owner, w.tenantA, 1, "always");
      const t = newToken();
      await asUser(db, w.sales, w.tenantA);
      const { rows } = await db.query<{ r: Record<string, unknown> }>(
        "select public.prepare_quote_resend($1, $2, $3, $4, $5, $6, $7) as r",
        [
          sent.quoteId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          t.sha,
          "v1.to.to",
          sha256Hex("otro@ejemplo.test"),
        ],
      );
      expect(rows[0].r.status).toBe("prepared");
      expect(rows[0].r.package_id).toBe(sent.packageId);
      // y el paquete sigue apuntando a la versión 1, la que regía cuando salió
      await actAsPostgres(db);
      const { rows: pkg } = await db.query(
        `select r.version from public.quote_packages p
           join public.approval_rules r on r.tenant_id = p.tenant_id and r.id = p.approval_rule_id where p.id = $1`,
        [sent.packageId],
      );
      expect(pkg[0].version).toBe(1);
    });
  });
});

describe("el campo del paquete no se inventa ni se cambia", () => {
  it("lo escribe el disparador: lo que traiga la fila (aunque sea la regla de otra organización) se ignora", async () => {
    await withTx(db, async () => {
      const { quoteId } = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, plain(50_000));
      await actAsPostgres(db);
      const { rows: foreign } = await db.query<{ id: string }>(
        "select id from public.approval_rules where tenant_id = $1 and version = 1",
        [w.tenantB],
      );
      const { rows: own } = await db.query<{ id: string }>(
        "select id from public.approval_rules where tenant_id = $1 and version = 1",
        [w.tenantA],
      );
      const pkg = randomUUID();
      await db.query(
        `insert into public.quote_packages
           (id, tenant_id, quote_id, send_key, issue_date, valid_until, email_subject, email_body_md,
            customer_snapshot_enc, created_by, approval_rule_id)
         values ($1, $2, $3, $4, app.current_business_date(), app.current_business_date() + 10, 's', 'b', 'v1.x.y', $5, $6)`,
        [pkg, w.tenantA, quoteId, randomUUID(), w.sales.id, foreign[0].id],
      );
      const { rows } = await db.query(
        "select approval_rule_id from public.quote_packages where id = $1",
        [pkg],
      );
      expect(rows[0].approval_rule_id).toBe(own[0].id);
    });
  });

  it("no se puede cambiar después (ni dejarlo vacío)", async () => {
    await withTx(db, async () => {
      const { quoteId } = await createQuoteWith(db, w.sales, w.tenantA, w.customerA, plain(50_000));
      await actAsPostgres(db);
      const { id } = await insertPackage(db, w.tenantA, quoteId, w.sales);
      await setRule(db, w.owner, w.tenantA, 1, "always");
      const { rows: next } = await db.query<{ id: string }>(
        "select id from public.approval_rules where tenant_id = $1 and version = 2",
        [w.tenantA],
      );
      const change = await expectSqlError(
        db,
        "update public.quote_packages set approval_rule_id = $1 where id = $2",
        [next[0].id, id],
      );
      expect(change.code).toBe("42501");
      const empty = await expectSqlError(
        db,
        "update public.quote_packages set approval_rule_id = null where id = $1",
        [id],
      );
      expect(["42501", "23502"]).toContain(empty.code);
    });
  });

  it("es obligatorio y apunta a una regla de la MISMA organización (relación compuesta)", async () => {
    await actAsPostgres(db);
    const { rows } = await db.query(
      `select a.attnotnull as not_null,
              (select count(*)::int from pg_constraint c
                where c.conrelid = 'public.quote_packages'::regclass and c.contype = 'f'
                  and c.confrelid = 'public.approval_rules'::regclass
                  and array(select attname::text from pg_attribute where attrelid = c.conrelid and attnum = any (c.conkey)
                            order by attname) = array['approval_rule_id', 'tenant_id']) as fk
         from pg_attribute a
        where a.attrelid = 'public.quote_packages'::regclass and a.attname = 'approval_rule_id'`,
    );
    expect(rows[0]).toEqual({ not_null: true, fk: 1 });
  });
});

describe("si la organización no tiene regla, no se deja pasar", () => {
  it("CP423 approval_rule_missing (sin paquete ni candado)", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await createQuoteWith(
        db,
        w.sales,
        w.tenantA,
        w.customerA,
        plain(50_000),
      );
      await actAsPostgres(db);
      // Un daño imposible por los caminos normales (la tabla no se borra): se monta apagando los disparadores en esta
      // conexión y esta transacción, que se deshace.
      await db.query("set local session_replication_role = replica");
      await db.query("delete from public.approval_rules where tenant_id = $1", [w.tenantA]);
      await db.query("set local session_replication_role = origin");
      const { error } = await tryPrepare(db, w.sales, w.tenantA, quoteId, revision);
      expect(error?.code).toBe(LOCKED);
      expect(error?.message).toBe("approval_rule_missing");
      expect(await sendFootprint(db, w.tenantA, quoteId)).toMatchObject({
        packages: 0,
        locked: false,
      });
    });
  });
});

describe("la regla que cambia justo antes de enviar (dos conexiones, organización propia)", () => {
  /** Una organización con Dueño y una Comercial, confirmada, para que dos conexiones la vean. */
  async function ownTenant() {
    const owner = await createUser(db);
    const sales = await createUser(db);
    await db.query("begin");
    const tenant = await createTenantAs(db, owner, "76086428-5", "Carrera de envíos");
    await db.query(
      "insert into public.members (tenant_id, user_id, role) values ($1, $2, 'sales')",
      [tenant, sales.id],
    );
    const customer = randomUUID();
    await db.query(
      "insert into public.customers (id, tenant_id, kind, display_name) values ($1, $2, 'company', 'Cliente carrera')",
      [customer, tenant],
    );
    await db.query("commit");
    return { owner, sales, tenant, customer };
  }

  /** Crea la cotización y la confirma (las dos conexiones de la prueba tienen que verla). */
  async function committedQuote(t: Awaited<ReturnType<typeof ownTenant>>, spec: QuoteSpec) {
    await db.query("begin");
    const quote = await createQuoteWith(db, t.sales, t.tenant, t.customer, spec);
    await db.query("commit");
    await actAsPostgres(db);
    return quote;
  }

  it("la regla cambia primero (aún sin confirmar): el envío espera, y al confirmarse lo ve y se rechaza", async () => {
    const t = await ownTenant();
    const quote = await committedQuote(t, plain(50_000));
    const [admin, sender] = await Promise.all([connect(), connect()]);
    try {
      await admin.query("begin");
      await asUser(admin, t.owner, t.tenant);
      await admin.query(SET, [1, "always", null, null]); // toma el candado y no confirma todavía
      const attempt = (async () => {
        await sender.query("begin");
        await asUser(sender, t.sales, t.tenant);
        try {
          await sender.query(PREPARE_SQL, prepareArgs(quote.quoteId, quote.revision, prepareIds()));
          await sender.query("commit");
          return { ok: true as const };
        } catch (error) {
          await sender.query("rollback");
          return {
            ok: false as const,
            code: (error as { code?: string }).code,
            message: (error as Error).message,
          };
        }
      })();
      // el envío no puede terminar mientras la regla no se confirme
      const early = await Promise.race([
        attempt,
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 700)),
      ]);
      expect(early).toBe("waiting");
      await admin.query("commit");
      expect(await attempt).toEqual({ ok: false, code: LOCKED, message: "approval_required" });
    } finally {
      await Promise.all([admin.end(), sender.end()]);
    }
  });

  it("el envío empieza primero (aún sin confirmar): el cambio de regla espera, y el envío queda con la versión que regía", async () => {
    const t = await ownTenant();
    const quote = await committedQuote(t, plain(50_000));
    const [admin, sender] = await Promise.all([connect(), connect()]);
    try {
      await sender.query("begin");
      await asUser(sender, t.sales, t.tenant);
      const ids = prepareIds();
      await sender.query(PREPARE_SQL, prepareArgs(quote.quoteId, quote.revision, ids)); // tiene el candado compartido
      const change = (async () => {
        await admin.query("begin");
        await asUser(admin, t.owner, t.tenant);
        const { rows } = await admin.query<{ r: { version: number } }>(SET, [
          1,
          "always",
          null,
          null,
        ]);
        await admin.query("commit");
        return rows[0].r.version;
      })();
      const early = await Promise.race([
        change,
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 700)),
      ]);
      expect(early).toBe("waiting");
      await sender.query("commit");
      expect(await change).toBe(2);
      await actAsPostgres(db);
      const { rows } = await db.query(
        `select r.version, r.mode from public.quote_packages p
           join public.approval_rules r on r.tenant_id = p.tenant_id and r.id = p.approval_rule_id where p.id = $1`,
        [ids.packageId],
      );
      expect(rows[0]).toEqual({ version: 1, mode: "never" });
    } finally {
      await Promise.all([admin.end(), sender.end()]);
    }
  });

  it("dos envíos a la vez no se esperan entre sí (el candado de la regla es compartido)", async () => {
    const t = await ownTenant();
    const q1 = await committedQuote(t, plain(50_000));
    const q2 = await committedQuote(t, plain(60_000));
    const [a, b] = await Promise.all([connect(), connect()]);
    try {
      await a.query("begin");
      await b.query("begin");
      await asUser(a, t.sales, t.tenant);
      await asUser(b, t.sales, t.tenant);
      await a.query(PREPARE_SQL, prepareArgs(q1.quoteId, q1.revision, prepareIds()));
      // el segundo termina aunque el primero siga abierto
      const second = await Promise.race([
        b.query(PREPARE_SQL, prepareArgs(q2.quoteId, q2.revision, prepareIds())).then(() => "done"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
      ]);
      expect(second).toBe("done");
      await a.query("commit");
      await b.query("commit");
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });
});
