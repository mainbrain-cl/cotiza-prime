// Sprint 3 · M23 · Funciones del enlace del cliente (solo para el servidor): leer, anotar la apertura
// y responder. Cada prueba corre en una transacción que se deshace.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAsAnon, actAsPostgres, connect, expectSqlError, withTx } from "./helpers";
import {
  actAsService,
  asUser,
  buildWorld,
  newToken,
  sendQuoteAs,
  sha256Hex,
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

async function service<T = Json>(sql: string, params: unknown[]): Promise<T> {
  await actAsService(db);
  const { rows } = await db.query<{ r: T }>(sql, params);
  await actAsPostgres(db);
  return rows[0].r;
}
async function serviceError(sql: string, params: unknown[]) {
  await actAsService(db);
  const err = await expectSqlError(db, sql, params);
  await actAsPostgres(db);
  return err;
}

const read = (sha: string) => service("select public.share_link_read($1) as r", [sha]);
const view = (sha: string, ip: string | null = "v1.ip.ip", ua: string | null = "Mozilla/5.0") =>
  service("select public.share_link_record_view($1, $2, $3) as r", [sha, ip, ua]);

const RESPOND_SQL =
  "select public.share_link_respond($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as r";
const ENC_TEXT = `v1.${"x".repeat(20)}.${"y".repeat(60)}`;
function respondArgs(sha: string, over: Record<number, unknown> = {}) {
  const args: unknown[] = [
    sha,
    randomUUID(),
    randomUUID(),
    "accepted",
    "v1.nombre.cifrado",
    null,
    null,
    "v1.ip.cifrada",
    "203.0.113.9",
    "Mozilla/5.0 (X11)",
    "v1",
  ];
  for (const [index, value] of Object.entries(over)) args[Number(index) - 1] = value;
  return args;
}
const respond = (sha: string, over: Record<number, unknown> = {}) =>
  service(
    "select public.share_link_respond($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as r",
    respondArgs(sha, over),
  );
const rejectArgs = { 4: "rejected", 5: null, 6: "price_too_high", 11: null };
const respondError = (sha: string, over: Record<number, unknown> = {}) =>
  serviceError(RESPOND_SQL, respondArgs(sha, over));

async function send(): Promise<SentQuote> {
  return sendQuoteAs(db, w.sales, w.tenantA, w.customerA);
}
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  await actAsPostgres(db);
  const { rows } = await db.query(sql, params);
  return rows[0] as T;
}
const count = async (sql: string, params: unknown[] = []) =>
  Number((await one<{ n: string }>(sql, params)).n);
const quoteRow = (id: string) => one<Json>("select * from public.quotes where id = $1", [id]);

describe("permisos", () => {
  it("solo el servidor ejecuta estas funciones: ni anon ni una persona con sesión", async () => {
    await withTx(db, async () => {
      const q = await send();
      const calls: [string, unknown[]][] = [
        ["select public.share_link_read($1)", [q.sha]],
        ["select public.share_link_record_view($1, null, null)", [q.sha]],
        [RESPOND_SQL, respondArgs(q.sha)],
      ];
      for (const [sql, params] of calls) {
        await actAsAnon(db);
        expect((await expectSqlError(db, sql, params)).code, sql).toBe(FORBIDDEN);
        for (const user of [w.sales, w.owner, w.ownerB]) {
          await asUser(db, user, w.tenantA);
          expect((await expectSqlError(db, sql, params)).code, `${sql} ${user.email}`).toBe(
            FORBIDDEN,
          );
        }
        await actAsPostgres(db);
      }
      expect(await quoteRow(q.quoteId)).toMatchObject({ status: "sent" });
    });
  });
});

describe("share_link_read", () => {
  it("un enlace vigente entrega la cotización congelada y el contacto, sin cambiar nada", async () => {
    await withTx(db, async () => {
      const q = await send();
      const before = await quoteRow(q.quoteId);
      const r = await read(q.sha);
      expect(r).toMatchObject({
        state: "ok",
        quote_id: q.quoteId,
        package_id: q.packageId,
        share_link_id: q.linkId,
        tenant_id: w.tenantA,
        quote_status: "sent",
        response: null,
        customer_snapshot_enc: "v1.snap.snap",
        pdf_path: `${w.tenantA}/${q.quoteId}/${q.packageId}.pdf`,
        pdf_sha256: sha256Hex("pdf"),
        org_contact: {
          name: "Negocio Ficticio",
          detail_lines: ["RUT 76.086.428-5", "contacto@ejemplo.test"],
        },
      });
      expect(JSON.stringify(r)).not.toMatch(/token|bank|cuenta/i);
      expect(await quoteRow(q.quoteId)).toEqual(before);
      expect(
        await count(
          "select count(*)::text as n from public.share_link_views where share_link_id = $1",
          [q.linkId],
        ),
      ).toBe(0);
    });
  });

  it("token desconocido, mal formado o de un enlace que nunca salió: 'no existe', sin pistas", async () => {
    await withTx(db, async () => {
      expect(await read(newToken().sha)).toEqual({ state: "not_found" });
      expect(await read("corto")).toEqual({ state: "not_found" });
      expect(await service("select public.share_link_read(null) as r", [])).toEqual({
        state: "not_found",
      });
    });
  });

  it("revocado, vencido o reemplazado: solo el contacto de la organización, nunca la cotización", async () => {
    await withTx(db, async () => {
      const q = await send();
      await asUser(db, w.sales, w.tenantA);
      await db.query("select public.revoke_quote_links($1)", [q.quoteId]);
      await actAsPostgres(db);
      const revoked = await read(q.sha);
      expect(revoked).toMatchObject({
        state: "revoked",
        org_contact: { name: "Negocio Ficticio" },
      });
      expect(Object.keys(revoked).sort()).toEqual(["org_contact", "state"]);
    });
    await withTx(db, async () => {
      const q = await send();
      await db.query(
        "update public.quotes set valid_until = app.current_business_date() - 1 where id = $1",
        [q.quoteId],
      );
      const expired = await read(q.sha);
      expect(expired).toMatchObject({ state: "expired" });
      expect(Object.keys(expired).sort()).toEqual(["org_contact", "state"]);
      // vence ahí mismo, con su evento de sistema
      expect(await quoteRow(q.quoteId)).toMatchObject({ status: "expired" });
      expect(
        await one(
          "select actor_type from public.quote_events where quote_id = $1 and type = 'expired'",
          [q.quoteId],
        ),
      ).toMatchObject({ actor_type: "system" });
      await read(q.sha); // repetir no duplica el evento
      expect(
        await count(
          "select count(*)::text as n from public.quote_events where quote_id = $1 and type = 'expired'",
          [q.quoteId],
        ),
      ).toBe(1);
    });
    await withTx(db, async () => {
      const q = await send();
      await db.query("alter table public.quotes disable trigger quotes_status_transition_guard");
      await db.query("update public.quotes set status = 'superseded' where id = $1", [q.quoteId]);
      expect(await read(q.sha)).toMatchObject({ state: "superseded" });
    });
  });

  it("la vigencia vale hasta el último día inclusive", async () => {
    await withTx(db, async () => {
      const q = await send();
      await db.query(
        "update public.quotes set valid_until = app.current_business_date() where id = $1",
        [q.quoteId],
      );
      expect(await read(q.sha)).toMatchObject({ state: "ok" });
    });
  });

  it("ya respondida: sigue mostrando la cotización con su respuesta; una aceptada nunca vence", async () => {
    await withTx(db, async () => {
      const q = await send();
      await respond(q.sha);
      await db.query(
        "update public.quotes set valid_until = app.current_business_date() - 30 where id = $1",
        [q.quoteId],
      );
      const r = await read(q.sha);
      expect(r).toMatchObject({
        state: "responded",
        quote_status: "accepted",
        response: { decision: "accepted" },
      });
      expect(r.document_snapshot).toBeDefined();
      expect(await quoteRow(q.quoteId)).toMatchObject({ status: "accepted" });
    });
  });
});

describe("share_link_record_view", () => {
  it("la primera apertura pasa a 'Vista' con un solo evento; las siguientes solo suman", async () => {
    await withTx(db, async () => {
      const q = await send();
      expect(await view(q.sha)).toEqual({ recorded: true, first: true });
      expect(await quoteRow(q.quoteId)).toMatchObject({ status: "viewed" });
      expect((await quoteRow(q.quoteId)).first_viewed_at).not.toBeNull();
      expect(await view(q.sha)).toEqual({ recorded: true, first: false });
      expect(
        await count(
          "select count(*)::text as n from public.quote_events where quote_id = $1 and type = 'viewed'",
          [q.quoteId],
        ),
      ).toBe(1);
      expect(
        await one("select view_count from public.share_links where id = $1", [q.linkId]),
      ).toMatchObject({ view_count: 2 });
      expect(
        await count(
          "select count(*)::text as n from public.share_link_views where share_link_id = $1",
          [q.linkId],
        ),
      ).toBe(2);
      const ev = await one<{ data: Json; actor_type: string }>(
        "select data, actor_type from public.quote_events where quote_id = $1 and type = 'viewed'",
        [q.quoteId],
      );
      expect(ev.actor_type).toBe("public");
      expect(JSON.stringify(ev.data)).not.toMatch(/ip|agent/i);
    });
  });

  it("recorta el navegador a 120 caracteres sin caracteres de control; la IP queda tal cual (cifrada)", async () => {
    await withTx(db, async () => {
      const q = await send();
      await view(q.sha, "v1.ip.ip", `Mozilla\u0001\u0007${"x".repeat(200)}`);
      const row = await one<{ user_agent_short: string; ip_enc: string }>(
        "select user_agent_short, ip_enc from public.share_link_views where share_link_id = $1",
        [q.linkId],
      );
      expect(row.user_agent_short).toHaveLength(120);
      expect(row.user_agent_short.startsWith("Mozilla")).toBe(true);
      expect(row.ip_enc).toBe("v1.ip.ip");
      await view(q.sha, null, null);
      expect(
        await count(
          "select count(*)::text as n from public.share_link_views where share_link_id = $1 and ip_enc is null and user_agent_short is null",
          [q.linkId],
        ),
      ).toBe(1);
      expect(
        (
          await serviceError("select public.share_link_record_view($1, $2, null)", [
            q.sha,
            "x".repeat(2001),
          ])
        ).code,
      ).toBe(INVALID);
    });
  });

  it("no cuenta: enlace desconocido, revocado o vencido", async () => {
    await withTx(db, async () => {
      expect(await view(newToken().sha)).toEqual({ recorded: false });
      const q = await send();
      await asUser(db, w.sales, w.tenantA);
      await db.query("select public.revoke_quote_links($1)", [q.quoteId]);
      await actAsPostgres(db);
      expect(await view(q.sha)).toEqual({ recorded: false });
      expect(await quoteRow(q.quoteId)).toMatchObject({ status: "sent", first_viewed_at: null });
    });
    await withTx(db, async () => {
      const q = await send();
      await db.query(
        "update public.quotes set valid_until = app.current_business_date() - 1 where id = $1",
        [q.quoteId],
      );
      expect(await view(q.sha)).toEqual({ recorded: false });
      expect(
        await count(
          "select count(*)::text as n from public.share_link_views where share_link_id = $1",
          [q.linkId],
        ),
      ).toBe(0);
    });
  });

  it("abrir un enlace de reenvío cuando la cotización ya fue vista no repite el evento", async () => {
    await withTx(db, async () => {
      const q = await send();
      await view(q.sha);
      const t = newToken();
      const emailId = randomUUID();
      await asUser(db, w.sales, w.tenantA);
      await db.query("select public.prepare_quote_resend($1, $2, $3, $4, $5, 'v1.to.to', $6)", [
        q.quoteId,
        randomUUID(),
        emailId,
        randomUUID(),
        t.sha,
        sha256Hex("x"),
      ]);
      await db.query("select public.confirm_email_dispatch($1, 'memory', 'prov-resend')", [
        emailId,
      ]);
      await actAsPostgres(db);
      expect(await view(t.sha)).toMatchObject({ recorded: true });
      expect(
        await count(
          "select count(*)::text as n from public.quote_events where quote_id = $1 and type = 'viewed'",
          [q.quoteId],
        ),
      ).toBe(1);
      // y ese enlace nuevo lee la misma cotización congelada
      expect(await read(t.sha)).toMatchObject({ state: "ok", package_id: q.packageId });
    });
  });
});

describe("share_link_respond", () => {
  it("aceptar: queda en el registro de conformidad, con el sello del contenido y la IP real en la auditoría", async () => {
    await withTx(db, async () => {
      const q = await send();
      await view(q.sha);
      const responseId = randomUUID();
      const r = await respond(q.sha, { 2: responseId });
      expect(r).toMatchObject({
        result: "ok",
        replayed: false,
        decision: "accepted",
        response_id: responseId,
        tenant_id: w.tenantA,
        quote_id: q.quoteId,
        author_id: w.sales.id,
      });
      expect(await quoteRow(q.quoteId)).toMatchObject({ status: "accepted" });
      expect((await quoteRow(q.quoteId)).responded_at).not.toBeNull();
      const row = await one<Json>("select * from public.quote_responses where id = $1", [
        responseId,
      ]);
      expect(row).toMatchObject({
        decision: "accepted",
        package_content_sha256: q.contentSha,
        acceptance_text_version: "v1",
        acceptor_name_enc: "v1.nombre.cifrado",
        ip_enc: "v1.ip.cifrada",
        package_id: q.packageId,
        share_link_id: q.linkId,
        reason_code: null,
      });
      const ev = await one<{ actor_type: string; actor_user_id: string | null; data: Json }>(
        "select actor_type, actor_user_id, data from public.quote_events where quote_id = $1 and type = 'accepted'",
        [q.quoteId],
      );
      expect(ev).toMatchObject({ actor_type: "public", actor_user_id: null, data: {} });
      const audit = await one<{
        actor_type: string;
        origin_ip: string;
        details: Json;
        result: string;
      }>(
        "select actor_type, origin_ip, details, result from public.audit_log where resource_id = $1 and action = 'quote.accepted'",
        [q.quoteId],
      );
      expect(audit).toMatchObject({
        actor_type: "public",
        origin_ip: "203.0.113.9",
        result: "success",
      });
      expect(JSON.stringify(audit.details)).not.toMatch(/nombre|v1\./);
    });
  });

  it("rechazar con motivo de la lista; con 'otro' lleva su texto; el motivo va a la historia, el texto no", async () => {
    await withTx(db, async () => {
      const q = await send();
      const r = await respond(q.sha, { ...rejectArgs, 6: "other", 7: ENC_TEXT });
      expect(r).toMatchObject({ result: "ok", decision: "rejected" });
      expect(await quoteRow(q.quoteId)).toMatchObject({ status: "rejected_by_customer" });
      const ev = await one<{ data: Json }>(
        "select data from public.quote_events where quote_id = $1 and type = 'rejected_by_customer'",
        [q.quoteId],
      );
      expect(ev.data).toEqual({ reason_code: "other" });
      const audit = await one<{ action: string; details: Json }>(
        "select action, details from public.audit_log where resource_id = $1 and action = 'quote.rejected'",
        [q.quoteId],
      );
      expect(audit.details).toMatchObject({ reason_code: "other" });
      expect(JSON.stringify(audit.details)).not.toContain("xxxx");
    });
    for (const code of [
      "price_too_high",
      "not_in_budget",
      "chose_other_provider",
      "timing",
      "no_longer_needed",
    ]) {
      await withTx(db, async () => {
        const q = await send();
        expect(await respond(q.sha, { ...rejectArgs, 6: code })).toMatchObject({ result: "ok" });
      });
    }
  });

  it("revalida todo aunque la aplicación ya lo hizo (CP422, y no cambia nada)", async () => {
    await withTx(db, async () => {
      const q = await send();
      const bad: Record<string, Record<number, unknown>> = {
        "decisión inventada": { 4: "quizás" },
        "decisión vacía": { 4: null },
        "aceptar sin nombre": { 5: null },
        "aceptar sin versión del texto": { 11: null },
        "aceptar con motivo": { 6: "timing" },
        "rechazar sin motivo": { ...rejectArgs, 6: null },
        "rechazar con motivo inventado": { ...rejectArgs, 6: "porque sí" },
        "rechazar con nombre": { ...rejectArgs, 5: "v1.n.n" },
        "'otro' sin texto": { ...rejectArgs, 6: "other" },
        "'otro' con texto demasiado corto": { ...rejectArgs, 6: "other", 7: "v1.corto" },
        "'otro' con texto demasiado largo": {
          ...rejectArgs,
          6: "other",
          7: `v1.${"x".repeat(1300)}`,
        },
        "motivo de la lista con texto": { ...rejectArgs, 7: ENC_TEXT },
        "IP demasiado larga": { 8: "x".repeat(2001) },
      };
      for (const [label, over] of Object.entries(bad)) {
        expect((await respondError(q.sha, over)).code, label).toBe(INVALID);
      }
      expect(await quoteRow(q.quoteId)).toMatchObject({ status: "sent", responded_at: null });
      expect(
        await count("select count(*)::text as n from public.quote_responses where quote_id = $1", [
          q.quoteId,
        ]),
      ).toBe(0);
      expect(
        (
          await serviceError(
            RESPOND_SQL,
            [...respondArgs(q.sha)].map((v, i) => (i === 2 ? null : v)),
          )
        ).code,
      ).toBe(INVALID);
    });
  });

  it("el mismo clic repetido (misma clave) devuelve lo mismo; con otra clave, la primera respuesta gana", async () => {
    await withTx(db, async () => {
      const q = await send();
      const key = randomUUID();
      const first = await respond(q.sha, { 3: key });
      const again = await respond(q.sha, { 3: key });
      expect(again).toMatchObject({
        result: "ok",
        replayed: true,
        decision: "accepted",
        response_id: first.response_id,
      });
      expect(
        await count("select count(*)::text as n from public.quote_responses where quote_id = $1", [
          q.quoteId,
        ]),
      ).toBe(1);
      // otra clave, y hasta la decisión contraria: ya respondida, nada cambia
      const other = await respond(q.sha, rejectArgs);
      expect(other).toMatchObject({ result: "already_responded", decision: "accepted" });
      expect(await quoteRow(q.quoteId)).toMatchObject({ status: "accepted" });
      expect(
        await count(
          "select count(*)::text as n from public.quote_events where quote_id = $1 and type in ('accepted', 'rejected_by_customer')",
          [q.quoteId],
        ),
      ).toBe(1);
    });
  });

  it("no responde: enlace desconocido, revocado, vencido o reemplazado", async () => {
    await withTx(db, async () => {
      expect(await respond(newToken().sha)).toEqual({ result: "not_found" });
      expect((await respondError("corto")).code).toBe(INVALID);
    });
    await withTx(db, async () => {
      const q = await send();
      await asUser(db, w.sales, w.tenantA);
      await db.query("select public.revoke_quote_links($1)", [q.quoteId]);
      await actAsPostgres(db);
      expect(await respond(q.sha)).toEqual({ result: "revoked" });
      expect(await quoteRow(q.quoteId)).toMatchObject({ status: "sent" });
    });
    await withTx(db, async () => {
      const q = await send();
      await db.query(
        "update public.quotes set valid_until = app.current_business_date() - 1 where id = $1",
        [q.quoteId],
      );
      expect(await respond(q.sha)).toEqual({ result: "expired" });
      expect(await quoteRow(q.quoteId)).toMatchObject({ status: "expired", responded_at: null });
      expect(
        await count("select count(*)::text as n from public.quote_responses where quote_id = $1", [
          q.quoteId,
        ]),
      ).toBe(0);
      expect(await respond(q.sha)).toEqual({ result: "expired" }); // y de nuevo: ya vencida
    });
    await withTx(db, async () => {
      const q = await send();
      await db.query("alter table public.quotes disable trigger quotes_status_transition_guard");
      await db.query("update public.quotes set status = 'superseded' where id = $1", [q.quoteId]);
      expect(await respond(q.sha)).toEqual({ result: "superseded" });
    });
  });

  it("el último día de vigencia todavía se puede aceptar", async () => {
    await withTx(db, async () => {
      const q = await send();
      await db.query(
        "update public.quotes set valid_until = app.current_business_date() where id = $1",
        [q.quoteId],
      );
      expect(await respond(q.sha)).toMatchObject({ result: "ok" });
    });
  });

  it("no acepta un enlace que nunca se activó (envío fallido) ni uno de un envío abandonado", async () => {
    await withTx(db, async () => {
      const q = await send();
      // un segundo enlace del mismo paquete, sin activar
      const t = newToken();
      await db.query(
        `insert into public.email_messages (id, tenant_id, quote_id, package_id, kind, to_email_enc, to_email_hash, provider)
         values ($1, $2, $3, $4, 'quote_resend', 'x', $5, 'pending')`,
        [randomUUID(), w.tenantA, q.quoteId, q.packageId, sha256Hex("z")],
      );
      const email = await one<{ id: string }>(
        "select id from public.email_messages where quote_id = $1 and kind = 'quote_resend'",
        [q.quoteId],
      );
      await db.query(
        "insert into public.share_links (id, tenant_id, quote_id, package_id, email_message_id, token_sha256) values ($1, $2, $3, $4, $5, $6)",
        [randomUUID(), w.tenantA, q.quoteId, q.packageId, email.id, t.sha],
      );
      expect(await respond(t.sha)).toEqual({ result: "not_found" });
      expect(await read(t.sha)).toEqual({ state: "not_found" });
      expect(await view(t.sha)).toEqual({ recorded: false });
    });
  });
});
