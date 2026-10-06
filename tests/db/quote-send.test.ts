// Sprint 3 Â· M22 Â· Funciones para enviar la cotizaciÃ³n: preparar, adjuntar el PDF, confirmar o
// fallar el envÃ­o, reenviar y revocar enlaces. Cada prueba corre en una transacciÃ³n que se deshace.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAs, actAsPostgres, connect, expectSqlError, withTx, type TestUser } from "./helpers";
import {
  asUser,
  buildWorld,
  createQuote,
  newToken,
  sha256Hex,
  tokenOfEmail,
  tokenOfPackage,
  type World,
} from "./send-helpers";

const FORBIDDEN = "42501";
const NOT_FOUND = "CP404";
const CONFLICT = "CP409";
const INVALID = "CP422";
const LOCKED = "CP423";
const TOO_MANY = "CP429";

let db: Client;
let w: World;
beforeAll(async () => {
  db = await connect();
  w = await buildWorld(db);
});
afterAll(async () => {
  await db.end();
});

interface Ids {
  sendKey: string;
  packageId: string;
  emailId: string;
  linkId: string;
  token: string;
  sha: string;
}
const newIds = (): Ids => ({
  sendKey: randomUUID(),
  packageId: randomUUID(),
  emailId: randomUUID(),
  linkId: randomUUID(),
  ...newToken(),
});

const PREPARE_SQL =
  "select public.prepare_quote_send($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as r";
function prepareArgs(
  quoteId: string,
  revision: number,
  ids: Ids,
  over: Record<number, unknown> = {},
) {
  const args: unknown[] = [
    quoteId,
    revision,
    ids.sendKey,
    ids.packageId,
    ids.emailId,
    ids.linkId,
    ids.sha,
    "Su cotizaciÃ³n",
    "Hola, **adjunto** la cotizaciÃ³n.",
    "v1.to.to",
    sha256Hex("cliente@ejemplo.test"),
    "v1.snap.snap",
  ];
  for (const [index, value] of Object.entries(over)) args[Number(index) - 1] = value;
  return args;
}

async function revisionOf(quoteId: string): Promise<number> {
  await actAsPostgres(db);
  const { rows } = await db.query<{ revision: number }>(
    "select revision from public.quotes where id = $1",
    [quoteId],
  );
  return rows[0].revision;
}

/** CotizaciÃ³n de la vendedora `sales` lista para enviar (con una lÃ­nea). */
async function readyQuote(
  author: TestUser = w.sales,
): Promise<{ quoteId: string; revision: number }> {
  const quoteId = await createQuote(db, author, w.tenantA, w.customerA);
  return { quoteId, revision: await revisionOf(quoteId) };
}

async function prepare(
  user: TestUser,
  quoteId: string,
  revision: number,
  ids = newIds(),
  over = {},
) {
  await asUser(db, user, w.tenantA);
  const { rows } = await db.query<{ r: Record<string, unknown> }>(
    PREPARE_SQL,
    prepareArgs(quoteId, revision, ids, over),
  );
  await actAsPostgres(db);
  return { ids, result: rows[0].r };
}
async function prepareError(
  user: TestUser,
  quoteId: string,
  revision: number,
  ids = newIds(),
  over = {},
  tenant = w.tenantA,
) {
  await asUser(db, user, tenant);
  const err = await expectSqlError(db, PREPARE_SQL, prepareArgs(quoteId, revision, ids, over));
  await actAsPostgres(db);
  return err;
}

async function putObject(path: string, size = 1234) {
  await db.query(
    "insert into storage.objects (bucket_id, name, metadata) values ('quote-documents', $1, $2::jsonb)",
    [path, JSON.stringify({ size })],
  );
}

const attachSql =
  "select public.attach_quote_package_document($1, $2, $3, $4, $5, $6::jsonb, $7, $8)";
function attachArgs(quoteId: string, ids: Ids, over: Record<number, unknown> = {}) {
  const args: unknown[] = [
    ids.packageId,
    `${w.tenantA}/${quoteId}/${ids.packageId}.pdf`,
    sha256Hex("pdf"),
    1234,
    null,
    JSON.stringify({ ok: true }),
    sha256Hex("contenido"),
    ids.sha,
  ];
  for (const [index, value] of Object.entries(over)) args[Number(index) - 1] = value;
  return args;
}
async function attach(
  user: TestUser,
  quoteId: string,
  ids: Ids,
  over: Record<number, unknown> = {},
  upload = true,
) {
  const args = attachArgs(quoteId, ids, over);
  if (upload) await putObject(`${w.tenantA}/${quoteId}/${ids.packageId}.pdf`);
  await asUser(db, user, w.tenantA);
  await db.query(attachSql, args);
  await actAsPostgres(db);
}
async function attachError(
  user: TestUser,
  quoteId: string,
  ids: Ids,
  over: Record<number, unknown> = {},
  tenant = w.tenantA,
) {
  await asUser(db, user, tenant);
  const err = await expectSqlError(db, attachSql, attachArgs(quoteId, ids, over));
  await actAsPostgres(db);
  return err;
}

async function confirm(
  user: TestUser,
  emailId: string,
  providerId = "prov-1",
  provider = "memory",
  tenant = w.tenantA,
) {
  const sha = await tokenOfEmail(db, emailId);
  await asUser(db, user, tenant);
  const { rows } = await db.query<{ r: { status: string } }>(
    "select public.confirm_email_dispatch($1, $2, $3, $4) as r",
    [emailId, provider, providerId, sha],
  );
  await actAsPostgres(db);
  return rows[0].r;
}
async function confirmError(
  user: TestUser,
  emailId: string,
  providerId = "prov-1",
  provider = "memory",
  tenant = w.tenantA,
) {
  const sha = await tokenOfEmail(db, emailId);
  await asUser(db, user, tenant);
  const err = await expectSqlError(db, "select public.confirm_email_dispatch($1, $2, $3, $4)", [
    emailId,
    provider,
    providerId,
    sha,
  ]);
  await actAsPostgres(db);
  return err;
}

/** EnvÃ­a de punta a punta: prepara, sube el PDF, lo adjunta y confirma. */
async function sendQuote(author: TestUser = w.sales) {
  const { quoteId, revision } = await readyQuote(author);
  const { ids } = await prepare(author, quoteId, revision);
  await attach(author, quoteId, ids);
  await confirm(author, ids.emailId);
  return { quoteId, ids };
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  await actAsPostgres(db);
  const { rows } = await db.query(sql, params);
  return rows[0] as T;
}
const quoteRow = (id: string) =>
  one<Record<string, unknown>>("select * from public.quotes where id = $1", [id]);

describe("prepare_quote_send", () => {
  it("congela el paquete: crea paquete, enlace inactivo y correo pendiente, y toma el candado", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids, result } = await prepare(w.sales, quoteId, revision);
      expect(result).toMatchObject({ status: "prepared", package_id: ids.packageId });
      const pkg = await one<Record<string, unknown>>(
        "select * from public.quote_packages where id = $1",
        [ids.packageId],
      );
      expect(pkg).toMatchObject({
        state: "preparing",
        send_key: ids.sendKey,
        email_subject: "Su cotizaciÃ³n",
      });
      const dates = await one<{ issue: string; valid: string; today: string; def: number }>(
        `select p.issue_date::text as issue, p.valid_until::text as valid, app.current_business_date()::text as today,
                (select default_validity_days from public.tenants where tenant_id = p.tenant_id) as def
           from public.quote_packages p where p.id = $1`,
        [ids.packageId],
      );
      expect(dates.issue).toBe(dates.today);
      const expected = await one<{ d: string }>(
        "select (app.current_business_date() + $1::int)::text as d",
        [dates.def],
      );
      expect(dates.valid).toBe(expected.d);
      const link = await one<Record<string, unknown>>(
        "select * from public.share_links where id = $1",
        [ids.linkId],
      );
      expect(link).toMatchObject({
        activated_at: null,
        revoked_at: null,
        token_sha256: ids.sha,
        email_message_id: ids.emailId,
      });
      const mail = await one<Record<string, unknown>>(
        "select * from public.email_messages where id = $1",
        [ids.emailId],
      );
      expect(mail).toMatchObject({
        kind: "quote",
        status: "pending",
        provider: "pending",
        share_link_id: ids.linkId,
      });
      const q = await quoteRow(quoteId);
      expect(q).toMatchObject({ status: "draft", send_lock_key: ids.sendKey });
      expect(new Date(q.send_lock_until as string).getTime()).toBeGreaterThan(Date.now());
    });
  });

  it("la vigencia: en dÃ­as cuenta desde hoy, con fecha se respeta, y una fecha pasada se rechaza", async () => {
    await withTx(db, async () => {
      const a = await readyQuote();
      await db.query(
        "update public.quotes set validity_mode = 'days', validity_days = 7 where id = $1",
        [a.quoteId],
      );
      const { ids } = await prepare(w.sales, a.quoteId, a.revision);
      const days = await one<{ ok: boolean }>(
        "select valid_until = app.current_business_date() + 7 as ok from public.quote_packages where id = $1",
        [ids.packageId],
      );
      expect(days.ok).toBe(true);

      const b = await readyQuote();
      await db.query(
        "update public.quotes set validity_mode = 'date', validity_days = null, valid_until = app.current_business_date() where id = $1",
        [b.quoteId],
      );
      const today = await prepare(w.sales, b.quoteId, b.revision);
      const ok = await one<{ ok: boolean }>(
        "select valid_until = app.current_business_date() as ok from public.quote_packages where id = $1",
        [today.ids.packageId],
      );
      expect(ok.ok).toBe(true);

      const c = await readyQuote();
      await db.query(
        "update public.quotes set validity_mode = 'date', validity_days = null, valid_until = app.current_business_date() - 1 where id = $1",
        [c.quoteId],
      );
      expect((await prepareError(w.sales, c.quoteId, c.revision)).code).toBe(INVALID);
    });
  });

  it("solo el autor, con rol de ventas, envÃ­a: otro vendedor, Administrador, DueÃ±o, Aprobador y Observador no", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      for (const user of [w.sales2, w.admin, w.owner, w.approver, w.viewer]) {
        expect((await prepareError(user, quoteId, revision)).code, user.email).toBe(FORBIDDEN);
      }
      // sin organizaciÃ³n activa
      await actAsPostgres(db);
      await actAs(db, w.sales, {});
      expect(
        (await expectSqlError(db, PREPARE_SQL, prepareArgs(quoteId, revision, newIds()))).code,
      ).toBe(FORBIDDEN);
    });
  });

  it("una cotizaciÃ³n de otra organizaciÃ³n no se encuentra (CP404) y la de B queda intacta", async () => {
    await withTx(db, async () => {
      const quoteB = await createQuote(db, w.ownerB, w.tenantB, w.customerB);
      const revision = await revisionOf(quoteB);
      expect((await prepareError(w.sales, quoteB, revision)).code).toBe(NOT_FOUND);
      expect((await prepareError(w.owner, quoteB, revision)).code).toBe(NOT_FOUND);
      const row = await quoteRow(quoteB);
      expect(row).toMatchObject({ status: "draft", send_lock_key: null });
      expect(
        (
          await one<{ n: string }>(
            "select count(*)::text as n from public.quote_packages where quote_id = $1",
            [quoteB],
          )
        ).n,
      ).toBe("0");
    });
  });

  it("rechaza lo invÃ¡lido: sin lÃ­neas, revisiÃ³n distinta, cliente anonimizado, ya enviada, textos y sellos mal formados", async () => {
    await withTx(db, async () => {
      const empty = await createQuote(db, w.sales, w.tenantA, w.customerA, false);
      expect((await prepareError(w.sales, empty, await revisionOf(empty))).code).toBe(INVALID);

      const { quoteId, revision } = await readyQuote();
      expect((await prepareError(w.sales, quoteId, revision + 1)).code).toBe(CONFLICT);
      expect(
        (await prepareError(w.sales, quoteId, revision, newIds(), { 8: "dos\nlÃ­neas" })).code,
      ).toBe(INVALID);
      expect(
        (await prepareError(w.sales, quoteId, revision, newIds(), { 8: "x".repeat(151) })).code,
      ).toBe(INVALID);
      expect((await prepareError(w.sales, quoteId, revision, newIds(), { 8: "" })).code).toBe(
        INVALID,
      );
      expect(
        (await prepareError(w.sales, quoteId, revision, newIds(), { 9: "x".repeat(5001) })).code,
      ).toBe(INVALID);
      expect(
        (await prepareError(w.sales, quoteId, revision, newIds(), { 9: "con\u0001control" })).code,
      ).toBe(INVALID);
      expect((await prepareError(w.sales, quoteId, revision, newIds(), { 7: "corto" })).code).toBe(
        INVALID,
      );
      expect((await prepareError(w.sales, quoteId, revision, newIds(), { 11: "corto" })).code).toBe(
        INVALID,
      );
      expect((await prepareError(w.sales, quoteId, revision, newIds(), { 12: "" })).code).toBe(
        INVALID,
      );
      expect((await prepareError(w.sales, quoteId, revision, newIds(), { 10: null })).code).toBe(
        INVALID,
      );

      await db.query("update public.quotes set customer_id = $1 where id = $2", [
        w.customerAnon,
        quoteId,
      ]);
      expect((await prepareError(w.sales, quoteId, revision)).code).toBe(INVALID);
      await db.query("update public.quotes set customer_id = $1 where id = $2", [
        w.customerA,
        quoteId,
      ]);
      await db.query("update public.quotes set status = 'sent' where id = $1", [quoteId]);
      expect((await prepareError(w.sales, quoteId, revision)).code).toBe(LOCKED);
    });
  });

  it("el mismo clic repetido recibe 'en curso'; otro envÃ­o con otra clave choca (CP409)", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const first = await prepare(w.sales, quoteId, revision);
      const again = await prepare(w.sales, quoteId, revision, {
        ...newIds(),
        sendKey: first.ids.sendKey,
      });
      expect(again.result).toMatchObject({
        status: "in_progress",
        package_id: first.ids.packageId,
      });
      expect((await prepareError(w.sales, quoteId, revision)).code).toBe(CONFLICT);
      expect(
        (
          await one<{ n: string }>(
            "select count(*)::text as n from public.quote_packages where quote_id = $1",
            [quoteId],
          )
        ).n,
      ).toBe("1");
    });
  });

  it("si el envÃ­o anterior muriÃ³ a medias (candado vencido), se abandona y se parte de nuevo", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const first = await prepare(w.sales, quoteId, revision);
      await db.query(
        "update public.quotes set send_lock_until = now() - interval '1 second' where id = $1",
        [quoteId],
      );
      const second = await prepare(w.sales, quoteId, revision, {
        ...newIds(),
        sendKey: first.ids.sendKey,
      });
      expect(second.result).toMatchObject({ status: "prepared" });
      expect(
        await one("select state from public.quote_packages where id = $1", [first.ids.packageId]),
      ).toMatchObject({ state: "abandoned" });
      expect(
        await one("select status, error_code from public.email_messages where id = $1", [
          first.ids.emailId,
        ]),
      ).toMatchObject({ status: "failed", error_code: "abandoned" });
      expect(
        await one("select revoke_reason from public.share_links where id = $1", [first.ids.linkId]),
      ).toMatchObject({ revoke_reason: "failed_attempt" });
      expect(await quoteRow(quoteId)).toMatchObject({ send_lock_key: second.ids.sendKey });
    });
  });

  it("con el candado vigente el borrador no se guarda (CP423)", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      await prepare(w.sales, quoteId, revision);
      await asUser(db, w.sales, w.tenantA);
      const err = await expectSqlError(
        db,
        "select public.save_quote_draft($1, $2, gen_random_uuid(), $3::jsonb, '[]'::jsonb, $4::jsonb)",
        [
          quoteId,
          revision,
          JSON.stringify({ customer_id: w.customerA, global_discount: { kind: "none", value: 0 } }),
          JSON.stringify({
            subtotalTaxableClp: 0,
            subtotalExemptClp: 0,
            subtotalClp: 0,
            lineDiscountsClp: 0,
            globalDiscountClp: 0,
            globalDiscountTaxableClp: 0,
            globalDiscountExemptClp: 0,
            netTaxableClp: 0,
            netExemptClp: 0,
            taxClp: 0,
            totalClp: 0,
            lines: [],
          }),
        ],
      );
      expect(err.code).toBe(LOCKED);
    });
  });
});

describe("attach_quote_package_document", () => {
  it("deja el paquete listo con los datos del PDF", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      await attach(w.sales, quoteId, ids);
      const pkg = await one<Record<string, unknown>>(
        "select * from public.quote_packages where id = $1",
        [ids.packageId],
      );
      expect(pkg).toMatchObject({
        state: "ready",
        pdf_bytes: 1234,
        pdf_path: `${w.tenantA}/${quoteId}/${ids.packageId}.pdf`,
      });
      expect(pkg.document_snapshot).toEqual({ ok: true });
    });
  });

  it("ataque: una ruta de otra organizaciÃ³n, de otra cotizaciÃ³n o inventada se rechaza", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      const objB = `${w.tenantB}/${quoteId}/${ids.packageId}.pdf`;
      await putObject(objB);
      expect((await attachError(w.sales, quoteId, ids, { 2: objB })).code).toBe(INVALID);
      const other = `${w.tenantA}/${randomUUID()}/${ids.packageId}.pdf`;
      await putObject(other);
      expect((await attachError(w.sales, quoteId, ids, { 2: other })).code).toBe(INVALID);
      expect((await attachError(w.sales, quoteId, ids, { 2: "../../etc/passwd" })).code).toBe(
        INVALID,
      );
      // la ruta correcta pero sin archivo subido
      expect((await attachError(w.sales, quoteId, ids)).code).toBe(INVALID);
      // tamaÃ±o distinto al del archivo
      await putObject(`${w.tenantA}/${quoteId}/${ids.packageId}.pdf`, 999);
      expect((await attachError(w.sales, quoteId, ids)).code).toBe(INVALID);
      expect(
        await one("select state, pdf_path from public.quote_packages where id = $1", [
          ids.packageId,
        ]),
      ).toMatchObject({ state: "preparing", pdf_path: null });
    });
  });

  it("valida sellos, tamaÃ±o, copia del documento y logo", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      await putObject(`${w.tenantA}/${quoteId}/${ids.packageId}.pdf`);
      expect((await attachError(w.sales, quoteId, ids, { 3: "x" })).code).toBe(INVALID);
      expect((await attachError(w.sales, quoteId, ids, { 7: "x" })).code).toBe(INVALID);
      expect((await attachError(w.sales, quoteId, ids, { 4: 0 })).code).toBe(INVALID);
      expect((await attachError(w.sales, quoteId, ids, { 4: 20971521 })).code).toBe(INVALID);
      expect((await attachError(w.sales, quoteId, ids, { 6: "[]" })).code).toBe(INVALID);
      expect(
        (await attachError(w.sales, quoteId, ids, { 6: JSON.stringify({ x: "x".repeat(300000) }) }))
          .code,
      ).toBe(INVALID);
      expect(
        (
          await attachError(w.sales, quoteId, ids, {
            5: `${w.tenantA}/${quoteId}/${ids.packageId}-logo.png`,
          })
        ).code,
      ).toBe(INVALID); // sin archivo
      expect(
        (
          await attachError(w.sales, quoteId, ids, {
            5: `${w.tenantB}/${quoteId}/${ids.packageId}-logo.png`,
          })
        ).code,
      ).toBe(INVALID);
      // con logo subido sÃ­
      await putObject(`${w.tenantA}/${quoteId}/${ids.packageId}-logo.png`);
      await asUser(db, w.sales, w.tenantA);
      await db.query(
        attachSql,
        attachArgs(quoteId, ids, { 5: `${w.tenantA}/${quoteId}/${ids.packageId}-logo.png` }),
      );
    });
  });

  it("solo el autor, de su organizaciÃ³n, y solo mientras el paquete se prepara", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      await putObject(`${w.tenantA}/${quoteId}/${ids.packageId}.pdf`);
      for (const user of [w.sales2, w.admin, w.approver, w.viewer]) {
        expect((await attachError(user, quoteId, ids)).code, user.email).toBe(FORBIDDEN);
      }
      expect((await attachError(w.ownerB, quoteId, ids, {}, w.tenantB)).code).toBe(NOT_FOUND);
      await attach(w.sales, quoteId, ids, {}, false);
      expect((await attachError(w.sales, quoteId, ids)).code).toBe(LOCKED); // ya estÃ¡ listo
      expect(
        await one("select state from public.quote_packages where id = $1", [ids.packageId]),
      ).toMatchObject({ state: "ready" });
    });
    await withTx(db, async () => {
      // abandonado: ya no es el envÃ­o vigente
      const { quoteId, revision } = await readyQuote();
      const first = await prepare(w.sales, quoteId, revision);
      await db.query(
        "update public.quotes set send_lock_until = now() - interval '1 second' where id = $1",
        [quoteId],
      );
      await prepare(w.sales, quoteId, revision);
      expect((await attachError(w.sales, quoteId, first.ids)).code).toBe(LOCKED);
    });
  });
});

describe("confirm_email_dispatch", () => {
  it("el primer envÃ­o: correo enviado, enlace activo, paquete enviado y cotizaciÃ³n 'Enviada' con su vigencia", async () => {
    await withTx(db, async () => {
      const { quoteId, ids } = await sendQuote();
      expect(
        await one(
          "select status, provider, provider_message_id from public.email_messages where id = $1",
          [ids.emailId],
        ),
      ).toMatchObject({ status: "sent", provider: "memory", provider_message_id: "prov-1" });
      const link = await one<{ activated_at: string | null }>(
        "select activated_at from public.share_links where id = $1",
        [ids.linkId],
      );
      expect(link.activated_at).not.toBeNull();
      expect(
        await one("select state from public.quote_packages where id = $1", [ids.packageId]),
      ).toMatchObject({ state: "sent" });
      const q = await quoteRow(quoteId);
      expect(q).toMatchObject({
        status: "sent",
        current_package_id: ids.packageId,
        send_lock_key: null,
        send_lock_until: null,
        validity_mode: "days",
      });
      expect(q.sent_at).not.toBeNull();
      expect(q.valid_until).not.toBeNull();
      // lÃ­nea de tiempo y auditorÃ­a, sin datos personales
      const ev = await one<{ type: string; data: Record<string, unknown> }>(
        "select type, data from public.quote_events where quote_id = $1 and type = 'sent'",
        [quoteId],
      );
      expect(ev.data).toEqual({ package_id: ids.packageId, email_message_id: ids.emailId });
      const audit = await one<{ action: string; actor_user_id: string; details: unknown }>(
        "select action, actor_user_id, details from public.audit_log where resource_id = $1 and action = 'quote.sent'",
        [quoteId],
      );
      expect(audit.actor_user_id).toBe(w.sales.id);
      expect(JSON.stringify(audit.details)).not.toContain("@");
    });
  });

  it("repetir la confirmaciÃ³n es inocuo; con otro identificador, no", async () => {
    await withTx(db, async () => {
      const { ids } = await sendQuote();
      expect(await confirm(w.sales, ids.emailId)).toEqual({ status: "already_confirmed" });
      expect((await confirmError(w.sales, ids.emailId, "otro")).code).toBe(LOCKED);
    });
  });

  it("no se confirma antes de adjuntar el PDF, ni por otra persona, ni de otra organizaciÃ³n, ni con proveedor 'pending'", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      expect((await confirmError(w.sales, ids.emailId)).code).toBe(LOCKED);
      await attach(w.sales, quoteId, ids);
      expect((await confirmError(w.sales2, ids.emailId)).code).toBe(FORBIDDEN);
      expect((await confirmError(w.admin, ids.emailId)).code).toBe(FORBIDDEN);
      expect((await confirmError(w.viewer, ids.emailId)).code).toBe(FORBIDDEN);
      expect((await confirmError(w.ownerB, ids.emailId, "x", "memory", w.tenantB)).code).toBe(
        NOT_FOUND,
      );
      expect((await confirmError(w.sales, ids.emailId, "x", "pending")).code).toBe(INVALID);
      expect((await confirmError(w.sales, ids.emailId, "")).code).toBe(INVALID);
      expect((await quoteRow(quoteId)).status).toBe("draft");
    });
  });
});

describe("fail_email_dispatch", () => {
  const fail = async (
    user: TestUser,
    emailId: string,
    code = "smtp_timeout",
    tenant = w.tenantA,
  ) => {
    const sha = await tokenOfEmail(db, emailId);
    await asUser(db, user, tenant);
    await db.query("select public.fail_email_dispatch($1, $2, $3)", [emailId, code, sha]);
    await actAsPostgres(db);
  };
  const failError = async (
    user: TestUser,
    emailId: string,
    code = "smtp_timeout",
    tenant = w.tenantA,
  ) => {
    const sha = await tokenOfEmail(db, emailId);
    await asUser(db, user, tenant);
    const err = await expectSqlError(db, "select public.fail_email_dispatch($1, $2, $3)", [
      emailId,
      code,
      sha,
    ]);
    await actAsPostgres(db);
    return err;
  };

  it("el correo y el paquete fallan, el enlace se revoca, se suelta el candado y la cotizaciÃ³n sigue Borrador", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      await attach(w.sales, quoteId, ids);
      await fail(w.sales, ids.emailId);
      expect(
        await one("select status, error_code from public.email_messages where id = $1", [
          ids.emailId,
        ]),
      ).toMatchObject({ status: "failed", error_code: "smtp_timeout" });
      expect(
        await one("select state from public.quote_packages where id = $1", [ids.packageId]),
      ).toMatchObject({ state: "failed" });
      expect(
        await one("select revoke_reason, activated_at from public.share_links where id = $1", [
          ids.linkId,
        ]),
      ).toMatchObject({ revoke_reason: "failed_attempt", activated_at: null });
      expect(await quoteRow(quoteId)).toMatchObject({
        status: "draft",
        send_lock_key: null,
        send_lock_until: null,
      });
      expect(
        await one(
          "select data from public.quote_events where quote_id = $1 and type = 'send_failed'",
          [quoteId],
        ),
      ).toMatchObject({ data: { code: "smtp_timeout" } });
      expect(
        await one(
          "select result from public.audit_log where resource_id = $1 and action = 'quote.send_failed'",
          [quoteId],
        ),
      ).toMatchObject({ result: "failure" });
      await fail(w.sales, ids.emailId); // repetido: inocuo
      // y se puede volver a intentar con claves nuevas
      const retry = await prepare(w.sales, quoteId, revision);
      expect(retry.result).toMatchObject({ status: "prepared" });
    });
  });

  it("no falla un correo ya enviado; el cÃ³digo no admite datos personales; solo el autor", async () => {
    await withTx(db, async () => {
      const { ids } = await sendQuote();
      expect((await failError(w.sales, ids.emailId)).code).toBe(LOCKED);
    });
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      expect((await failError(w.sales, ids.emailId, "dato@ejemplo.test")).code).toBe(INVALID);
      expect((await failError(w.sales2, ids.emailId)).code).toBe(FORBIDDEN);
      expect((await failError(w.ownerB, ids.emailId, "x", w.tenantB)).code).toBe(NOT_FOUND);
    });
  });
});

describe("prepare_quote_resend", () => {
  const RESEND_SQL = "select public.prepare_quote_resend($1, $2, $3, $4, $5, $6, $7) as r";
  const resendArgs = (quoteId: string, emailId = randomUUID()) => {
    const t = newToken();
    return {
      args: [
        quoteId,
        randomUUID(),
        emailId,
        randomUUID(),
        t.sha,
        "v1.to.to",
        sha256Hex("otro@ejemplo.test"),
      ],
      emailId,
      ...t,
    };
  };
  const resend = async (user: TestUser, quoteId: string, emailId = randomUUID()) => {
    const a = resendArgs(quoteId, emailId);
    await asUser(db, user, w.tenantA);
    const { rows } = await db.query<{ r: Record<string, unknown> }>(RESEND_SQL, a.args);
    await actAsPostgres(db);
    return { ...a, result: rows[0].r };
  };
  const resendError = async (
    user: TestUser,
    quoteId: string,
    emailId = randomUUID(),
    tenant = w.tenantA,
  ) => {
    await asUser(db, user, tenant);
    const err = await expectSqlError(db, RESEND_SQL, resendArgs(quoteId, emailId).args);
    await actAsPostgres(db);
    return err;
  };

  it("antes de enviar no hay nada que reenviar", async () => {
    await withTx(db, async () => {
      const { quoteId } = await readyQuote();
      expect((await resendError(w.sales, quoteId)).code).toBe(LOCKED);
    });
  });

  it("reenvÃ­a el mismo paquete y el mismo PDF con enlace nuevo; el enlace anterior sigue como estaba", async () => {
    await withTx(db, async () => {
      const { quoteId, ids } = await sendQuote();
      const r = await resend(w.sales, quoteId);
      expect(r.result).toMatchObject({
        status: "prepared",
        package_id: ids.packageId,
        pdf_path: `${w.tenantA}/${quoteId}/${ids.packageId}.pdf`,
      });
      expect(r.result.pdf_sha256).toBe(sha256Hex("pdf"));
      expect(
        await one("select kind, status, provider from public.email_messages where id = $1", [
          r.emailId,
        ]),
      ).toMatchObject({ kind: "quote_resend", status: "pending", provider: "pending" });
      const old = await one<{ revoked_at: string | null; activated_at: string | null }>(
        "select revoked_at, activated_at from public.share_links where id = $1",
        [ids.linkId],
      );
      expect(old.revoked_at).toBeNull();
      expect(old.activated_at).not.toBeNull();
      // repetir con el mismo correo no crea otro
      const again = await resend(w.sales, quoteId, r.emailId);
      expect(again.result).toMatchObject({ status: "replayed" });
      // confirmar: evento 'resent' y enlace activo
      await confirm(w.sales, r.emailId, "prov-resend");
      expect(
        await one("select type from public.quote_events where quote_id = $1 and type = 'resent'", [
          quoteId,
        ]),
      ).toMatchObject({ type: "resent" });
      expect(
        (
          await one<{ activated_at: string | null }>(
            "select activated_at from public.share_links where email_message_id = $1",
            [r.emailId],
          )
        ).activated_at,
      ).not.toBeNull();
      expect(
        await one(
          "select action from public.audit_log where resource_id = $1 and action = 'quote.resent'",
          [quoteId],
        ),
      ).toMatchObject({ action: "quote.resent" });
    });
  });

  it("reenvÃ­an el autor, el DueÃ±o y el Administrador; no otro vendedor, Aprobador ni Observador; B no ve la cotizaciÃ³n", async () => {
    await withTx(db, async () => {
      const { quoteId } = await sendQuote();
      for (const user of [w.sales, w.owner, w.admin]) {
        expect((await resend(user, quoteId)).result.status, user.email).toBe("prepared");
      }
      for (const user of [w.sales2, w.approver, w.viewer]) {
        expect((await resendError(user, quoteId)).code, user.email).toBe(FORBIDDEN);
      }
      expect((await resendError(w.ownerB, quoteId, randomUUID(), w.tenantB)).code).toBe(NOT_FOUND);
    });
  });

  it("tiene tope por dÃ­a y no reenvÃ­a una cotizaciÃ³n cuya fecha ya pasÃ³", async () => {
    await withTx(db, async () => {
      const { quoteId } = await sendQuote();
      for (let i = 0; i < 5; i++) await resend(w.sales, quoteId);
      expect((await resendError(w.sales, quoteId)).code).toBe(TOO_MANY);
    });
    await withTx(db, async () => {
      const { quoteId } = await sendQuote();
      await db.query(
        "update public.quotes set valid_until = app.current_business_date() - 1 where id = $1",
        [quoteId],
      );
      expect((await resendError(w.sales, quoteId)).code).toBe(INVALID);
    });
  });
});

describe("revoke_quote_links", () => {
  const revoke = async (user: TestUser, quoteId: string, tenant = w.tenantA) => {
    await asUser(db, user, tenant);
    const { rows } = await db.query<{ n: number }>("select public.revoke_quote_links($1) as n", [
      quoteId,
    ]);
    await actAsPostgres(db);
    return rows[0].n;
  };
  const revokeError = async (user: TestUser, quoteId: string, tenant = w.tenantA) => {
    await asUser(db, user, tenant);
    const err = await expectSqlError(db, "select public.revoke_quote_links($1)", [quoteId]);
    await actAsPostgres(db);
    return err;
  };

  it("el autor revoca los enlaces activos; queda en la lÃ­nea de tiempo y en la auditorÃ­a; repetir da cero", async () => {
    await withTx(db, async () => {
      const { quoteId, ids } = await sendQuote();
      expect(await revoke(w.sales, quoteId)).toBe(1);
      expect(
        await one("select revoke_reason, revoked_by from public.share_links where id = $1", [
          ids.linkId,
        ]),
      ).toMatchObject({ revoke_reason: "manual", revoked_by: w.sales.id });
      expect(
        await one(
          "select data from public.quote_events where quote_id = $1 and type = 'link_revoked'",
          [quoteId],
        ),
      ).toMatchObject({ data: { count: 1 } });
      expect(
        await one(
          "select action from public.audit_log where resource_id = $1 and action = 'share_link.revoked'",
          [quoteId],
        ),
      ).toMatchObject({ action: "share_link.revoked" });
      expect(await revoke(w.sales, quoteId)).toBe(0);
    });
  });

  it("revocan el autor, el DueÃ±o y el Administrador; no otro vendedor, Aprobador ni Observador", async () => {
    for (const user of [w.owner, w.admin]) {
      await withTx(db, async () => {
        const { quoteId } = await sendQuote();
        expect(await revoke(user, quoteId)).toBe(1);
      });
    }
    await withTx(db, async () => {
      const { quoteId, ids } = await sendQuote();
      for (const user of [w.sales2, w.approver, w.viewer]) {
        expect((await revokeError(user, quoteId)).code, user.email).toBe(FORBIDDEN);
      }
      expect((await revokeError(w.ownerB, quoteId, w.tenantB)).code).toBe(NOT_FOUND);
      expect(
        (
          await one<{ revoked_at: string | null }>(
            "select revoked_at from public.share_links where id = $1",
            [ids.linkId],
          )
        ).revoked_at,
      ).toBeNull();
    });
  });

  it("no toca los enlaces que aÃºn no se activaron (un envÃ­o en curso)", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      expect(await revoke(w.sales, quoteId)).toBe(0);
      expect(
        (
          await one<{ revoked_at: string | null }>(
            "select revoked_at from public.share_links where id = $1",
            [ids.linkId],
          )
        ).revoked_at,
      ).toBeNull();
    });
  });
});

describe("migraciÃ³n 26 Â· lo enviado es lo guardado (B1)", () => {
  const ZERO_TOTALS = {
    subtotalTaxableClp: 0,
    subtotalExemptClp: 0,
    subtotalClp: 0,
    lineDiscountsClp: 0,
    globalDiscountClp: 0,
    globalDiscountTaxableClp: 0,
    globalDiscountExemptClp: 0,
    netTaxableClp: 0,
    netExemptClp: 0,
    taxClp: 0,
    totalClp: 0,
    lines: [],
  };
  async function saveDraft(user: TestUser, quoteId: string, revision: number) {
    await asUser(db, user, w.tenantA);
    await db.query(
      "select public.save_quote_draft($1, $2, gen_random_uuid(), $3::jsonb, '[]'::jsonb, $4::jsonb)",
      [
        quoteId,
        revision,
        JSON.stringify({ customer_id: w.customerA, global_discount: { kind: "none", value: 0 } }),
        JSON.stringify(ZERO_TOTALS),
      ],
    );
    await actAsPostgres(db);
  }
  const expireLock = (quoteId: string) =>
    db.query(
      "update public.quotes set send_lock_until = now() - interval '1 second' where id = $1",
      [quoteId],
    );

  it("el paquete recuerda la revisiÃ³n de la cotizaciÃ³n con que se armÃ³", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      expect(
        await one("select quote_revision from public.quote_packages where id = $1", [
          ids.packageId,
        ]),
      ).toEqual({ quote_revision: revision });
    });
  });

  it("candado vencido y borrador guardado: el candado se suelta y adjuntar se rechaza (CP409)", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      await expireLock(quoteId);
      await saveDraft(w.sales, quoteId, revision);
      expect(await quoteRow(quoteId)).toMatchObject({ send_lock_key: null, send_lock_until: null });
      await putObject(`${w.tenantA}/${quoteId}/${ids.packageId}.pdf`);
      expect((await attachError(w.sales, quoteId, ids)).code).toBe(CONFLICT);
      expect(
        await one("select state from public.quote_packages where id = $1", [ids.packageId]),
      ).toMatchObject({ state: "preparing" });
    });
  });

  it("candado vencido y borrador guardado despuÃ©s de adjuntar: confirmar se rechaza (CP409) y no sale nada", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      await attach(w.sales, quoteId, ids);
      await expireLock(quoteId);
      await saveDraft(w.sales, quoteId, revision);
      expect((await confirmError(w.sales, ids.emailId)).code).toBe(CONFLICT);
      expect(await quoteRow(quoteId)).toMatchObject({ status: "draft" });
      expect(
        await one("select status from public.email_messages where id = $1", [ids.emailId]),
      ).toMatchObject({ status: "pending" });
    });
  });

  it("aunque el candado siguiera puesto, un cambio de revisiÃ³n se rechaza igual (defensa en profundidad)", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      await attach(w.sales, quoteId, ids);
      // cambio directo de la revisiÃ³n por quien tiene todos los permisos (como un error futuro)
      await db.query(
        "update public.quotes set send_lock_until = null, send_lock_key = null where id = $1",
        [quoteId],
      );
      await db.query("update public.quotes set revision = revision + 1 where id = $1", [quoteId]);
      await db.query(
        "update public.quotes set send_lock_key = $2, send_lock_until = now() + interval '1 minute' where id = $1",
        [quoteId, ids.sendKey],
      );
      expect((await confirmError(w.sales, ids.emailId)).code).toBe(CONFLICT);
    });
  });

  it("con el candado vigente sigue sin guardarse (CP423) y el candado vigente no se suelta", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      await asUser(db, w.sales, w.tenantA);
      const err = await expectSqlError(
        db,
        "select public.save_quote_draft($1, $2, gen_random_uuid(), $3::jsonb, '[]'::jsonb, $4::jsonb)",
        [
          quoteId,
          revision,
          JSON.stringify({ customer_id: w.customerA, global_discount: { kind: "none", value: 0 } }),
          JSON.stringify(ZERO_TOTALS),
        ],
      );
      expect(err.code).toBe(LOCKED);
      await actAsPostgres(db);
      expect(await quoteRow(quoteId)).toMatchObject({ send_lock_key: ids.sendKey });
    });
  });
});

describe("migraciÃ³n 26 Â· solo quien armÃ³ el envÃ­o lo completa (I2)", () => {
  const WRONG = sha256Hex("otro token");

  it("adjuntar, confirmar y fallar con un token que no es el del envÃ­o se rechazan", async () => {
    await withTx(db, async () => {
      const { quoteId, revision } = await readyQuote();
      const { ids } = await prepare(w.sales, quoteId, revision);
      await putObject(`${w.tenantA}/${quoteId}/${ids.packageId}.pdf`);
      expect((await attachError(w.sales, quoteId, ids, { 8: WRONG })).code).toBe(FORBIDDEN);
      expect((await attachError(w.sales, quoteId, ids, { 8: "x" })).code).toBe(INVALID);
      await attach(w.sales, quoteId, ids, {}, false);

      await asUser(db, w.sales, w.tenantA);
      const confirmed = await expectSqlError(
        db,
        "select public.confirm_email_dispatch($1, 'memory', 'prov-x', $2)",
        [ids.emailId, WRONG],
      );
      expect(confirmed.code).toBe(FORBIDDEN);
      const failed = await expectSqlError(
        db,
        "select public.fail_email_dispatch($1, 'smtp_timeout', $2)",
        [ids.emailId, WRONG],
      );
      expect(failed.code).toBe(FORBIDDEN);
      const nulls = await expectSqlError(
        db,
        "select public.confirm_email_dispatch($1, 'memory', 'prov-x', null)",
        [ids.emailId],
      );
      expect(nulls.code).toBe(INVALID);
      await actAsPostgres(db);
      // nada cambiÃ³: sigue pendiente, y con el token correcto sale
      expect(
        await one("select status from public.email_messages where id = $1", [ids.emailId]),
      ).toMatchObject({ status: "pending" });
      expect(await confirm(w.sales, ids.emailId)).toEqual({ status: "confirmed" });
    });
  });

  it("el token de un envÃ­o no sirve para el paquete de otro (ni el de otra cotizaciÃ³n)", async () => {
    await withTx(db, async () => {
      const a = await readyQuote();
      const b = await readyQuote();
      const first = await prepare(w.sales, a.quoteId, a.revision);
      const second = await prepare(w.sales, b.quoteId, b.revision);
      await putObject(`${w.tenantA}/${b.quoteId}/${second.ids.packageId}.pdf`);
      expect((await attachError(w.sales, b.quoteId, second.ids, { 8: first.ids.sha })).code).toBe(
        FORBIDDEN,
      );
      expect(await tokenOfPackage(db, second.ids.packageId)).toBe(second.ids.sha);
    });
  });
});

describe("permisos de las funciones", () => {
  it("anon no ejecuta ninguna; las auxiliares de app no estÃ¡n al alcance de nadie con pase", async () => {
    await withTx(db, async () => {
      const { rows } = await db.query<{ name: string; anon: boolean; auth: boolean }>(
        `select p.proname as name, has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where (n.nspname = 'public' and p.proname in ('prepare_quote_send', 'attach_quote_package_document',
                   'confirm_email_dispatch', 'fail_email_dispatch', 'prepare_quote_resend', 'revoke_quote_links'))
             or (n.nspname = 'app' and p.proname in ('write_audit', 'write_quote_event', 'abandon_package'))`,
      );
      expect(rows).toHaveLength(9);
      for (const r of rows) {
        expect(r.anon, r.name).toBe(false);
        expect(r.auth, r.name).toBe(
          r.name.startsWith("write_") || r.name === "abandon_package" ? false : true,
        );
      }
    });
  });
});
