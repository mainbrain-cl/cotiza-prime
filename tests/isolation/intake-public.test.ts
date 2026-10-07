// Sprint 4 · Ataques 4, 5 y 8 de aislamiento: las funciones del portero del formulario público son solo del
// servidor, un servicio de B nunca entra a una solicitud de A, y un identificador público regenerado deja de
// funcionar. Siempre con pases reales y `fetch` directo; la llave maestra solo sirve como "el servidor".
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localEnv, rpc } from "../support/local-supabase";
import { fingerprint, fixture, openDb, tenantHeader, tokenOf } from "./context";
import { ISOLATION_TABLES } from "./registry";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const spec = (name: string) => ISOLATION_TABLES.find((t) => t.name === name)!;

/** Llama como el servidor de la aplicación (llave maestra), que es quien usa estas funciones. */
const asServer = (name: string, args: object) => {
  const { secretKey } = localEnv();
  return rpc(secretKey, name, args, { apikey: secretKey });
};

const submitArgs = (
  publicId: string,
  revision: number,
  items: { form_item_id: string; quantity_milli: number | null }[],
) => ({
  p_public_id: publicId,
  p_request_id: randomUUID(),
  p_submit_key: randomUUID(),
  p_form_revision: revision,
  p_contact_name_enc: "v1.nombre.cifrado",
  p_contact_email_enc: "v1.correo.cifrado",
  p_contact_phone_enc: null,
  p_company_enc: null,
  p_comuna_enc: null,
  p_service_address_enc: null,
  p_message_enc: null,
  p_contact_email_hash: "e".repeat(64),
  p_desired_date: null,
  p_items: items,
  p_consent_template_version: "intake-v1",
  p_consent_text: "Acepto que la organización use mis datos para responder esta solicitud.",
  p_consent_ip_enc: null,
});

const countRequests = async (formId: string) =>
  (
    await db.query<{ n: number }>(
      "select count(*)::int as n from public.intake_requests where form_id = $1",
      [formId],
    )
  ).rows[0].n;

describe("Ataque 4 · un servicio del formulario de B en el envío al formulario de A", () => {
  it("el servidor recibe el envío con el identificador público de A y un servicio de B: invalid_items, sin guardar nada", async () => {
    const fx = fixture();
    const a = fx.orgs.A.intake!;
    const b = fx.orgs.B.intake!;
    const requestsOfB = spec("intake_requests");
    const beforeB = await fingerprint(db, requestsOfB);
    const beforeA = await countRequests(a.formId);

    for (const items of [
      [{ form_item_id: b.freeItemId, quantity_milli: null }],
      [{ form_item_id: b.catalogFormItemId, quantity_milli: 2000 }],
      [
        { form_item_id: a.freeItemId, quantity_milli: null },
        { form_item_id: b.freeItemId, quantity_milli: null },
      ],
    ]) {
      const res = await asServer(
        "intake_request_submit",
        submitArgs(a.publicId, a.revision, items),
      );
      expect(res.status, res.text).toBe(200);
      expect((res.json as { result: string }).result).toBe("invalid_items");
      expect(res.text).not.toContain(fx.orgs.B.canary);
      expect(res.text).not.toContain(fx.orgs.B.tenantId);
    }
    expect(await countRequests(a.formId)).toBe(beforeA);
    expect(await fingerprint(db, requestsOfB), "las solicitudes de B cambiaron").toBe(beforeB);
    // lo único que cambia son los contadores de A (los bloqueos se cuentan en la organización dueña del formulario)
    const { rows } = await db.query<{ blocked_invalid: number }>(
      "select blocked_invalid from public.intake_daily_counters where form_id = $1 and day = app.current_business_date()",
      [a.formId],
    );
    expect(rows[0].blocked_invalid).toBeGreaterThanOrEqual(3);
  });

  it("control positivo: con sus propios servicios el envío entra, y en la organización del formulario (no en otra)", async () => {
    const fx = fixture();
    for (const key of ["A", "B"] as const) {
      const form = fx.orgs[key].intake!;
      const requestId = randomUUID();
      const res = await asServer("intake_request_submit", {
        ...submitArgs(form.publicId, form.revision, [
          { form_item_id: form.freeItemId, quantity_milli: 1500 },
          { form_item_id: form.catalogFormItemId, quantity_milli: 3000 },
        ]),
        p_request_id: requestId,
      });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toMatchObject({
        result: "ok",
        request_id: requestId,
        tenant_id: fx.orgs[key].tenantId,
      });
      const { rows } = await db.query<{ tenant_id: string; form_id: string }>(
        "select tenant_id, form_id from public.intake_requests where id = $1",
        [requestId],
      );
      expect(rows).toEqual([{ tenant_id: fx.orgs[key].tenantId, form_id: form.formId }]);
    }
  });
});

describe("Ataque 5 · las funciones del portero no las llama nadie con un pase ni sin sesión", () => {
  it("Ana, Beto y un visitante sin sesión, con ids reales, no pueden llamarlas directo", async () => {
    const fx = fixture();
    const a = fx.orgs.A.intake!;
    const b = fx.orgs.B.intake!;
    const calls: [string, object][] = [
      ["intake_form_read", { p_public_id: b.publicId }],
      [
        "intake_request_submit",
        submitArgs(b.publicId, b.revision, [{ form_item_id: b.freeItemId, quantity_milli: null }]),
      ],
      ["intake_record_block", { p_public_id: b.publicId, p_reason: "captcha" }],
      [
        "intake_notice_recipients",
        { p_request_id: b.requestId, p_kind: "request_received", p_form_id: null },
      ],
      [
        "intake_notice_register",
        {
          p_email_id: randomUUID(),
          p_request_id: b.requestId,
          p_kind: "request_received",
          p_to_user_id: fx.personas.ana.userId,
          p_to_email_enc: "ataque",
          p_to_email_hash: "0".repeat(64),
          p_form_id: null,
        },
      ],
      [
        "intake_notice_settle",
        {
          p_email_id: randomUUID(),
          p_provider: "memory",
          p_provider_message_id: "x",
          p_error_code: null,
        },
      ],
    ];
    const tables = ["intake_requests", "intake_daily_counters", "email_messages", "audit_log"].map(
      spec,
    );
    const before = new Map<string, string>();
    for (const t of tables) before.set(t.name, await fingerprint(db, t));
    const beforeA = await countRequests(a.formId);
    for (const token of [null, await tokenOf("ana"), await tokenOf("beto")]) {
      for (const header of [undefined, fx.orgs.A.tenantId, fx.orgs.B.tenantId]) {
        for (const [name, args] of calls) {
          const res = await rpc(token, name, args, tenantHeader(header));
          expect(res.status, `${name} ${token ? "con pase" : "anónimo"}`).toBeGreaterThanOrEqual(
            400,
          );
          expect(res.text).not.toContain(fx.orgs.B.canary);
        }
      }
    }
    for (const t of tables) {
      expect(await fingerprint(db, t), `${t.name} de B cambió`).toBe(before.get(t.name));
    }
    expect(await countRequests(a.formId)).toBe(beforeA);
  });

  it("control positivo: el servidor sí las ejecuta (así un rechazo no se debe a argumentos mal armados)", async () => {
    const fx = fixture();
    const b = fx.orgs.B.intake!;
    const read = await asServer("intake_form_read", { p_public_id: b.publicId });
    expect(read.status, read.text).toBe(200);
    const body = read.json as { state: string; tenant_id: string; items: { id: string }[] };
    expect(body.state).toBe("ok");
    expect(body.tenant_id).toBe(fx.orgs.B.tenantId);
    expect(body.items.map((i) => i.id).sort()).toEqual([b.freeItemId, b.catalogFormItemId].sort());
    // lo público no trae el servicio del catálogo ni ningún precio
    expect(read.text).not.toContain(b.catalogItemId);
    expect(read.text).not.toMatch(/price|cost|clp|tarif|amount|margin/i);
    expect(read.text).not.toContain(fx.orgs.A.canary);
    const unknown = await asServer("intake_form_read", { p_public_id: "A".repeat(22) });
    expect(unknown.json).toEqual({ state: "not_found" });
  });

  it("los destinatarios de un aviso son solo miembros activos de la organización de la solicitud, sin datos del visitante", async () => {
    const fx = fixture();
    const b = fx.orgs.B.intake!;
    const res = await asServer("intake_notice_recipients", {
      p_request_id: b.requestId,
      p_kind: "request_received",
      p_form_id: null,
    });
    expect(res.status, res.text).toBe(200);
    const body = res.json as { recipients: { user_id: string }[] };
    expect(body.recipients.length).toBeGreaterThan(0);
    const { rows } = await db.query<{ user_id: string }>(
      "select user_id from public.members where tenant_id = $1 and status = 'active' and role in ('owner', 'admin')",
      [fx.orgs.B.tenantId],
    );
    const managers = new Set(rows.map((r) => r.user_id));
    for (const recipient of body.recipients) expect(managers.has(recipient.user_id)).toBe(true);
    expect(res.text).not.toContain(fx.personas.ana.userId);
    expect(res.text).not.toContain(fx.personas.ana.email);
    expect(res.text).not.toContain(b.contactEmail);
    expect(res.text).not.toContain("Visitante");
  });
});

describe("Ataque 8 · un identificador público regenerado deja de funcionar", () => {
  it("Beto regenera el de su formulario: el viejo da not_found (leer y enviar) y el nuevo funciona", async () => {
    const fx = fixture();
    const token = await tokenOf("beto");
    const headers = tenantHeader(fx.orgs.B.tenantId);
    // un formulario propio de la prueba (no se toca el de la fixture)
    const formId = randomUUID();
    const itemId = randomUUID();
    const created = await rpc(
      token,
      "create_intake_form",
      { p_form_id: formId, p_name: "Para regenerar" },
      headers,
    );
    expect(created.status, created.text).toBe(200);
    const first = created.json as { public_id: string; revision: number };
    const saved = await rpc(
      token,
      "save_intake_form",
      {
        p_form_id: formId,
        p_expected_revision: first.revision,
        p_form: {},
        p_items: [
          {
            id: itemId,
            kind: "free",
            public_name: "Servicio",
            unit: "service",
            quantity_mode: "none",
          },
        ],
      },
      headers,
    );
    expect(saved.status, saved.text).toBe(200);
    const revision = (saved.json as { revision: number }).revision;
    const published = await rpc(
      token,
      "set_intake_form_status",
      { p_form_id: formId, p_status: "published" },
      headers,
    );
    expect(published.status, published.text).toBe(200);

    const stateOf = async (publicId: string) =>
      ((await asServer("intake_form_read", { p_public_id: publicId })).json as { state: string })
        .state;
    expect(await stateOf(first.public_id)).toBe("ok");
    const regenerated = await rpc(
      token,
      "regenerate_intake_form_public_id",
      { p_form_id: formId },
      headers,
    );
    expect(regenerated.status, regenerated.text).toBe(200);
    const next = (regenerated.json as { public_id: string }).public_id;
    expect(next).not.toBe(first.public_id);

    expect(await stateOf(first.public_id)).toBe("not_found");
    const oldSubmit = await asServer(
      "intake_request_submit",
      submitArgs(first.public_id, revision, [{ form_item_id: itemId, quantity_milli: null }]),
    );
    expect((oldSubmit.json as { result: string }).result).toBe("not_found");
    expect(await countRequests(formId)).toBe(0);
    expect(await stateOf(next)).toBe("ok");
    const newSubmit = await asServer(
      "intake_request_submit",
      submitArgs(next, revision, [{ form_item_id: itemId, quantity_milli: null }]),
    );
    expect((newSubmit.json as { result: string }).result).toBe("ok");
    expect(await countRequests(formId)).toBe(1);
    // y el formulario de A no se enteró
    expect(await stateOf(fx.orgs.A.intake!.publicId)).toBe("ok");
  });
});
