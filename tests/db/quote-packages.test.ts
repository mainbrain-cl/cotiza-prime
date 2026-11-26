// Sprint 3 · M20 · Paquete congelado, enlace del cliente, aperturas y bucket de documentos.
// Cada prueba corre en una transacción que se deshace; la fixture se deja confirmada una vez.
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
  readyPackage,
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

async function insertLink(
  tenantId: string,
  quoteId: string,
  packageId: string,
  sha = newToken().sha,
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.share_links (id, tenant_id, quote_id, package_id, email_message_id, token_sha256)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, tenantId, quoteId, packageId, randomUUID(), sha],
  );
  return id;
}

describe("quote_packages · solo agregar", () => {
  it("un paquete nace vacío y en preparación; no se puede crear ya listo", async () => {
    await withTx(db, async () => {
      const quoteId = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const err = await expectSqlError(
        db,
        `insert into public.quote_packages (id, tenant_id, quote_id, state, send_key, issue_date, valid_until,
           email_subject, email_body_md, customer_snapshot_enc, created_by)
         values (gen_random_uuid(), $1, $2, 'sent', gen_random_uuid(), current_date, current_date, 's', 'b', 'x', $3)`,
        [w.tenantA, quoteId, w.sales.id],
      );
      expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("los datos del PDF llegan una sola vez y solo mientras se prepara; luego nada cambia", async () => {
    await withTx(db, async () => {
      const quoteId = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const pkg = await insertPackage(db, w.tenantA, quoteId, w.sales);
      await readyPackage(db, w.tenantA, quoteId, pkg.id);
      const upd = (set: string) =>
        expectSqlError(db, `update public.quote_packages set ${set} where id = $1`, [pkg.id]);
      expect((await upd("pdf_bytes = 1")).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await upd("pdf_sha256 = repeat('a', 64)")).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await upd("email_subject = 'otro'")).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await upd("email_body_md = 'otro'")).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await upd("customer_snapshot_enc = 'otro'")).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await upd("valid_until = valid_until + 1")).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await upd("send_key = gen_random_uuid()")).code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("los estados avanzan solo por la lista: preparing → ready → sent; abandoned y failed son finales", async () => {
    await withTx(db, async () => {
      const quoteId = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const pkg = await insertPackage(db, w.tenantA, quoteId, w.sales);
      const move = (state: string) =>
        db.query("update public.quote_packages set state = $1 where id = $2", [state, pkg.id]);
      // preparing → sent salta un paso
      expect(
        (
          await expectSqlError(
            db,
            "update public.quote_packages set state = 'sent' where id = $1",
            [pkg.id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      // ready sin datos del PDF: la restricción de la tabla lo impide
      expect(
        (
          await expectSqlError(
            db,
            "update public.quote_packages set state = 'ready' where id = $1",
            [pkg.id],
          )
        ).code,
      ).toBe(CHECK_VIOLATION);
      await readyPackage(db, w.tenantA, quoteId, pkg.id);
      await move("sent");
      for (const next of ["ready", "preparing", "failed", "abandoned"]) {
        expect(
          (
            await expectSqlError(db, "update public.quote_packages set state = $1 where id = $2", [
              next,
              pkg.id,
            ])
          ).code,
        ).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });
    await withTx(db, async () => {
      const quoteId = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const pkg = await insertPackage(db, w.tenantA, quoteId, w.sales);
      await db.query("update public.quote_packages set state = 'abandoned' where id = $1", [
        pkg.id,
      ]);
      expect(
        (
          await expectSqlError(
            db,
            "update public.quote_packages set state = 'preparing' where id = $1",
            [pkg.id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("no se borra ni se vacía, ni siquiera como postgres", async () => {
    await withTx(db, async () => {
      const quoteId = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const pkg = await insertPackage(db, w.tenantA, quoteId, w.sales);
      expect(
        (await expectSqlError(db, "delete from public.quote_packages where id = $1", [pkg.id]))
          .code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await expectSqlError(db, "truncate public.quote_packages cascade")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });

  it("restricciones de forma: asunto sin saltos de línea, ruta del PDF propia, sellos de 64 hex, un solo paquete vivo", async () => {
    await withTx(db, async () => {
      const quoteId = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const bad = async (subject: string) => {
        await db.query("savepoint s");
        try {
          await insertPackage(db, w.tenantA, quoteId, w.sales, { subject });
          return undefined;
        } catch (e) {
          await db.query("rollback to savepoint s");
          return (e as { code?: string }).code;
        }
      };
      expect(await bad("línea 1\nlínea 2")).toBe(CHECK_VIOLATION);
      expect(await bad("con\rretorno")).toBe(CHECK_VIOLATION);
      expect(await bad("")).toBe(CHECK_VIOLATION);
      expect(await bad("x".repeat(151))).toBe(CHECK_VIOLATION);

      const pkg = await insertPackage(db, w.tenantA, quoteId, w.sales);
      // un segundo paquete vivo para la misma cotización
      expect(
        (
          await expectSqlError(
            db,
            `insert into public.quote_packages (id, tenant_id, quote_id, send_key, issue_date, valid_until,
             email_subject, email_body_md, customer_snapshot_enc, created_by)
           values (gen_random_uuid(), $1, $2, gen_random_uuid(), current_date, current_date, 's', 'b', 'x', $3)`,
            [w.tenantA, quoteId, w.sales.id],
          )
        ).code,
      ).toBe(UNIQUE_VIOLATION);
      // abandonado el primero, otro con la misma clave sí entra (se reintenta tras una falla)
      await db.query("update public.quote_packages set state = 'abandoned' where id = $1", [
        pkg.id,
      ]);
      await insertPackage(db, w.tenantA, quoteId, w.sales, { sendKey: pkg.sendKey });

      // ruta del PDF de otra organización o de otra cotización
      const other = await insertPackageForPath();
      expect(other.code).toBe(CHECK_VIOLATION);
    });
  });

  async function insertPackageForPath() {
    const quoteId = await createQuote(db, w.sales, w.tenantA, w.customerA);
    const pkg = await insertPackage(db, w.tenantA, quoteId, w.sales);
    return expectSqlError(
      db,
      `update public.quote_packages set pdf_path = $1, pdf_sha256 = repeat('a', 64), pdf_bytes = 10,
         document_snapshot = '{}'::jsonb, content_sha256 = repeat('b', 64), state = 'ready' where id = $2`,
      [`${w.tenantB}/${quoteId}/${pkg.id}.pdf`, pkg.id],
    );
  }

  it("la copia del documento tiene tope de 256 kB", async () => {
    await withTx(db, async () => {
      const quoteId = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const pkg = await insertPackage(db, w.tenantA, quoteId, w.sales);
      const err = await expectSqlError(
        db,
        `update public.quote_packages set document_snapshot = jsonb_build_object('x', (select string_agg(md5(i::text), '') from generate_series(1, 9000) i))
         where id = $1`,
        [pkg.id],
      );
      expect(err.code).toBe(CHECK_VIOLATION);
    });
  });

  it("una relación a una cotización de otra organización es imposible (relación compuesta)", async () => {
    await withTx(db, async () => {
      const quoteB = await createQuote(db, w.ownerB, w.tenantB, w.customerB);
      const err = await expectSqlError(
        db,
        `insert into public.quote_packages (id, tenant_id, quote_id, send_key, issue_date, valid_until,
           email_subject, email_body_md, customer_snapshot_enc, created_by)
         values (gen_random_uuid(), $1, $2, gen_random_uuid(), current_date, current_date, 's', 'b', 'x', $3)`,
        [w.tenantA, quoteB, w.sales.id],
      );
      expect(err.code).toBe(FK_VIOLATION);
    });
  });
});

describe("share_links", () => {
  it("el sello del token es único en toda la plataforma, aunque sea de otra organización", async () => {
    await withTx(db, async () => {
      const qa = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const qb = await createQuote(db, w.ownerB, w.tenantB, w.customerB);
      const pa = await insertPackage(db, w.tenantA, qa, w.sales);
      const pb = await insertPackage(db, w.tenantB, qb, w.ownerB);
      const { sha } = newToken();
      await insertLink(w.tenantA, qa, pa.id, sha);
      await expect(insertLink(w.tenantB, qb, pb.id, sha)).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      });
    });
  });

  it("el sello debe tener 64 hex y un enlace de A no apunta a un paquete de B", async () => {
    await withTx(db, async () => {
      const qa = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const qb = await createQuote(db, w.ownerB, w.tenantB, w.customerB);
      const pb = await insertPackage(db, w.tenantB, qb, w.ownerB);
      const shape = await expectSqlError(
        db,
        `insert into public.share_links (id, tenant_id, quote_id, package_id, email_message_id, token_sha256)
         values (gen_random_uuid(), $1, $2, gen_random_uuid(), gen_random_uuid(), 'corto')`,
        [w.tenantA, qa],
      );
      expect(shape.code).toBe(CHECK_VIOLATION);
      const cross = await expectSqlError(
        db,
        `insert into public.share_links (id, tenant_id, quote_id, package_id, email_message_id, token_sha256)
         values (gen_random_uuid(), $1, $2, $3, gen_random_uuid(), $4)`,
        [w.tenantA, qa, pb.id, newToken().sha],
      );
      expect(cross.code).toBe(FK_VIOLATION);
    });
  });

  it("solo se mueven la activación, la revocación (una vez) y las aperturas", async () => {
    await withTx(db, async () => {
      const q = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const p = await insertPackage(db, w.tenantA, q, w.sales);
      const id = await insertLink(w.tenantA, q, p.id);
      const upd = (set: string) =>
        expectSqlError(db, `update public.share_links set ${set} where id = $1`, [id]);
      expect((await upd("token_sha256 = repeat('0', 64)")).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await upd("package_id = gen_random_uuid()")).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await upd("email_message_id = gen_random_uuid()")).code).toBe(INSUFFICIENT_PRIVILEGE);

      await db.query("update public.share_links set activated_at = now() where id = $1", [id]);
      expect((await upd("activated_at = now() + interval '1 day'")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      await db.query(
        "update public.share_links set view_count = 1, first_viewed_at = now(), last_viewed_at = now() where id = $1",
        [id],
      );
      expect((await upd("view_count = 0")).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await upd("first_viewed_at = now() + interval '1 day'")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );

      // revocar exige motivo, y una vez revocado no se des-revoca ni se cambia el motivo
      expect((await upd("revoked_at = now()")).code).toBe(CHECK_VIOLATION);
      await db.query(
        "update public.share_links set revoked_at = now(), revoke_reason = 'manual' where id = $1",
        [id],
      );
      expect((await upd("revoked_at = null, revoke_reason = null")).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect((await upd("revoke_reason = 'new_version'")).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        (await expectSqlError(db, "delete from public.share_links where id = $1", [id])).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });
});

describe("share_link_views", () => {
  it("solo agregar: no se edita ni se borra, salvo la limpieza por plazo", async () => {
    await withTx(db, async () => {
      const q = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const p = await insertPackage(db, w.tenantA, q, w.sales);
      const link = await insertLink(w.tenantA, q, p.id);
      const { rows } = await db.query<{ id: string }>(
        `insert into public.share_link_views (tenant_id, share_link_id, ip_enc, user_agent_short)
         values ($1, $2, 'v1.a.b', 'Mozilla') returning id::text`,
        [w.tenantA, link],
      );
      const id = rows[0].id;
      expect(
        (
          await expectSqlError(
            db,
            "update public.share_link_views set user_agent_short = 'x' where id = $1",
            [id],
          )
        ).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        (await expectSqlError(db, "delete from public.share_link_views where id = $1", [id])).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      // aunque pida la limpieza, una apertura reciente no se borra
      await db.query("select set_config('app.retention_purge', 'on', true)");
      expect(
        (await expectSqlError(db, "delete from public.share_link_views where id = $1", [id])).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      // el navegador se recorta a 120 caracteres
      expect(
        (
          await expectSqlError(
            db,
            "insert into public.share_link_views (tenant_id, share_link_id, user_agent_short) values ($1, $2, $3)",
            [w.tenantA, link, "x".repeat(121)],
          )
        ).code,
      ).toBe(CHECK_VIOLATION);
    });
  });

  it("una apertura de hace más de 12 meses sí se borra, y solo con la marca de limpieza", async () => {
    await withTx(db, async () => {
      const q = await createQuote(db, w.sales, w.tenantA, w.customerA);
      const p = await insertPackage(db, w.tenantA, q, w.sales);
      const link = await insertLink(w.tenantA, q, p.id);
      const { rows } = await db.query<{ id: string }>(
        `insert into public.share_link_views (tenant_id, share_link_id, viewed_at)
         values ($1, $2, now() - interval '13 months') returning id::text`,
        [w.tenantA, link],
      );
      const id = rows[0].id;
      expect(
        (await expectSqlError(db, "delete from public.share_link_views where id = $1", [id])).code,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      await db.query("select set_config('app.retention_purge', 'on', true)");
      await db.query("delete from public.share_link_views where id = $1", [id]);
    });
  });
});

describe("lectura y permisos", () => {
  async function seed() {
    const q = await createQuote(db, w.sales, w.tenantA, w.customerA);
    const p = await insertPackage(db, w.tenantA, q, w.sales);
    const link = await insertLink(w.tenantA, q, p.id);
    await db.query(
      "insert into public.share_link_views (tenant_id, share_link_id, ip_enc) values ($1, $2, 'v1.a.b')",
      [w.tenantA, link],
    );
    return { q, p, link };
  }

  it("todos los miembros leen paquetes y enlaces, pero nadie lee token_sha256 ni la IP; B no ve nada de A", async () => {
    await withTx(db, async () => {
      const { p } = await seed();
      for (const user of [w.owner, w.admin, w.sales, w.sales2, w.approver, w.viewer]) {
        await asUser(db, user, w.tenantA);
        const pkgs = await db.query("select id from public.quote_packages where id = $1", [p.id]);
        expect(pkgs.rowCount).toBe(1);
        const links = await db.query(
          "select id, view_count from public.share_links where package_id = $1",
          [p.id],
        );
        expect(links.rowCount).toBe(1);
        expect((await expectSqlError(db, "select token_sha256 from public.share_links")).code).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect((await expectSqlError(db, "select * from public.share_links")).code).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect((await expectSqlError(db, "select ip_enc from public.share_link_views")).code).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect(
          (await expectSqlError(db, "select user_agent_short from public.share_link_views")).code,
        ).toBe(INSUFFICIENT_PRIVILEGE);
        await actAsPostgres(db);
      }
      // otra organización
      await asUser(db, w.ownerB, w.tenantB);
      expect((await db.query("select id from public.quote_packages")).rowCount).toBe(0);
      expect((await db.query("select id from public.share_links")).rowCount).toBe(0);
      expect((await db.query("select id from public.share_link_views")).rowCount).toBe(0);
    });
  });

  it("las aperturas las ven solo Dueño y Administrador", async () => {
    await withTx(db, async () => {
      await seed();
      for (const user of [w.owner, w.admin]) {
        await asUser(db, user, w.tenantA);
        expect((await db.query("select id from public.share_link_views")).rowCount).toBe(1);
        await actAsPostgres(db);
      }
      for (const user of [w.sales, w.sales2, w.approver, w.viewer]) {
        await asUser(db, user, w.tenantA);
        expect((await db.query("select id from public.share_link_views")).rowCount).toBe(0);
        await actAsPostgres(db);
      }
    });
  });

  it("nadie con pase escribe en estas tablas; anon no tiene nada", async () => {
    await withTx(db, async () => {
      const { p, link } = await seed();
      await asUser(db, w.owner, w.tenantA);
      const attempts = [
        ["update public.quote_packages set state = 'abandoned' where id = $1", [p.id]],
        ["delete from public.quote_packages where id = $1", [p.id]],
        [
          "update public.share_links set revoked_at = now(), revoke_reason = 'manual' where id = $1",
          [link],
        ],
        ["delete from public.share_links where id = $1", [link]],
        [
          "insert into public.share_link_views (tenant_id, share_link_id) values ($1, $2)",
          [w.tenantA, link],
        ],
      ] as const;
      for (const [sql, params] of attempts) {
        expect((await expectSqlError(db, sql, [...params])).code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
      await actAsPostgres(db);
      await db.query("set local role anon");
      for (const table of ["quote_packages", "share_links", "share_link_views"]) {
        expect((await expectSqlError(db, `select 1 from public.${table}`)).code, table).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
    });
  });
});

describe("quotes · candado de envío y cambios de estado", () => {
  it("con el candado vigente no se guarda el borrador (CP423); vencido, sí", async () => {
    await withTx(db, async () => {
      const q = await createQuote(db, w.sales, w.tenantA, w.customerA);
      await db.query(
        "update public.quotes set send_lock_key = gen_random_uuid(), send_lock_until = now() + interval '120 seconds' where id = $1",
        [q],
      );
      await asUser(db, w.sales, w.tenantA);
      const save = (rev: number) =>
        expectSqlError(
          db,
          "select public.save_quote_draft($1, $2, gen_random_uuid(), $3, '[]'::jsonb, $4)",
          [
            q,
            rev,
            JSON.stringify({
              customer_id: w.customerA,
              global_discount: { kind: "none", value: 0 },
            }),
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
      const { rows } = await db.query<{ revision: number }>(
        "select revision from public.quotes where id = $1",
        [q],
      );
      expect((await save(rows[0].revision)).code).toBe("CP423");
      await actAsPostgres(db);
      await db.query(
        "update public.quotes set send_lock_until = now() - interval '1 second' where id = $1",
        [q],
      );
      await asUser(db, w.sales, w.tenantA);
      // vencido el candado ya no lo bloquea (puede fallar por otro motivo, nunca por CP423)
      const err = await save(rows[0].revision).catch((e: Error) => ({
        code: "OK",
        message: e.message,
      }));
      expect(err.code).not.toBe("CP423");
    });
  });

  it("el candado se declara completo: llave y vencimiento juntos", async () => {
    await withTx(db, async () => {
      const q = await createQuote(db, w.sales, w.tenantA, w.customerA);
      expect(
        (
          await expectSqlError(
            db,
            "update public.quotes set send_lock_key = gen_random_uuid() where id = $1",
            [q],
          )
        ).code,
      ).toBe(CHECK_VIOLATION);
    });
  });

  it("cambios de estado: solo la lista cerrada, también como postgres", async () => {
    const statuses = (
      await db.query<{ s: string }>(
        `select unnest(array['draft','pending_approval','changes_requested','rejected_internal','sent','viewed',
        'rejected_by_customer','expired','accepted','pending_payment','pending_deposit','deposit_paid',
        'pending_balance','paid','superseded']) as s`,
      )
    ).rows.map((r) => r.s);
    const allowed = new Set([
      "draft>sent",
      "sent>viewed",
      "sent>accepted",
      "sent>rejected_by_customer",
      "sent>expired",
      "viewed>accepted",
      "viewed>rejected_by_customer",
      "viewed>expired",
      // Cobro (20261126100000): al aceptar con condición de pago, el disparador pasa a pendiente de pago o de anticipo.
      "accepted>pending_payment",
      "accepted>pending_deposit",
    ]);
    // Cada par se prueba en su propia transacción: la cotización parte del estado de origen.
    for (const from of ["draft", "sent", "viewed", "accepted", "expired"]) {
      for (const to of statuses) {
        if (from === to) continue;
        await withTx(db, async () => {
          const q = await createQuote(db, w.sales, w.tenantA, w.customerA);
          await db.query(
            "alter table public.quotes disable trigger quotes_status_transition_guard",
          );
          await db.query("update public.quotes set status = $1 where id = $2", [from, q]);
          await db.query("alter table public.quotes enable trigger quotes_status_transition_guard");
          const attempt = expectSqlError(db, "update public.quotes set status = $1 where id = $2", [
            to,
            q,
          ]);
          if (allowed.has(`${from}>${to}`)) {
            await expect(attempt).rejects.toThrow(/tuvo éxito/);
          } else {
            expect((await attempt).code, `${from} → ${to}`).toBe(INSUFFICIENT_PRIVILEGE);
          }
        });
      }
    }
  });
});

describe("bucket quote-documents", () => {
  it("es privado, con tope de 20 MB y solo PDF e imágenes", async () => {
    const { rows } = await db.query(
      "select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'quote-documents'",
    );
    expect(rows[0].public).toBe(false);
    expect(Number(rows[0].file_size_limit)).toBe(20 * 1024 * 1024);
    expect(rows[0].allowed_mime_types).toEqual([
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/svg+xml",
    ]);
  });

  it("los miembros de la organización activa solo leen su carpeta; nadie con pase escribe", async () => {
    await withTx(db, async () => {
      const objA = `${w.tenantA}/${randomUUID()}/${randomUUID()}.pdf`;
      const objB = `${w.tenantB}/${randomUUID()}/${randomUUID()}.pdf`;
      for (const name of [objA, objB]) {
        await db.query(
          "insert into storage.objects (bucket_id, name) values ('quote-documents', $1)",
          [name],
        );
      }
      await asUser(db, w.sales, w.tenantA);
      const own = await db.query(
        "select name from storage.objects where bucket_id = 'quote-documents'",
      );
      expect(own.rows.map((r) => r.name)).toEqual([objA]);
      for (const sql of [
        "insert into storage.objects (bucket_id, name) values ('quote-documents', $1)",
        "update storage.objects set name = name || 'x' where bucket_id = 'quote-documents' and name = $1",
        "delete from storage.objects where bucket_id = 'quote-documents' and name = $1",
      ]) {
        const attempt = await db.query("savepoint s").then(async () => {
          try {
            const r = await db.query(sql, [objA]);
            await db.query("release savepoint s");
            return { code: "OK", rows: r.rowCount };
          } catch (e) {
            await db.query("rollback to savepoint s");
            return { code: (e as { code?: string }).code, rows: 0 };
          }
        });
        // o error de permiso, o ninguna fila afectada
        expect(attempt.code === INSUFFICIENT_PRIVILEGE || attempt.rows === 0, sql).toBe(true);
      }
      await actAsPostgres(db);
      const { rows } = await db.query("select name from storage.objects where name = $1", [objA]);
      expect(rows).toHaveLength(1);
      // y B no ve el de A
      await asUser(db, w.ownerB, w.tenantB);
      const theirs = await db.query(
        "select name from storage.objects where bucket_id = 'quote-documents'",
      );
      expect(theirs.rows.map((r) => r.name)).toEqual([objB]);
    });
  });
});

describe("tope de intentos", () => {
  it("acepta los alcances nuevos y sigue rechazando los desconocidos", async () => {
    await withTx(db, async () => {
      for (const scope of ["share_ip", "share_token", "share_respond_ip", "quote_send_user"]) {
        await db.query("insert into public.auth_rate_limits (scope, key_hash) values ($1, $2)", [
          scope,
          sha256Hex(scope),
        ]);
      }
      expect(
        (
          await expectSqlError(
            db,
            "insert into public.auth_rate_limits (scope, key_hash) values ('otro', $1)",
            [sha256Hex("o")],
          )
        ).code,
      ).toBe(CHECK_VIOLATION);
    });
  });
});
