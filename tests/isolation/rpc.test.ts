// H-012 · Funciones expuestas por la API (RPC), el esquema interno y los servicios de Auth.
// Ataques A13, A13b, A14, A15, A16 y X6. Siempre con pases reales y `fetch` directo.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localEnv, rest, rpc } from "../support/local-supabase";
import {
  countWhere,
  fingerprint,
  fixture,
  isRejectedOrEmpty,
  openDb,
  tenantHeader,
  tokenOf,
} from "./context";
import { NUMBERING_PREFIX } from "./fixture";
import { ISOLATION_TABLES, RPC_CASES, SERVER_ONLY_FUNCTIONS } from "./registry";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const NOT_EXPOSED_STATUS = 406; // PostgREST: el esquema pedido no está expuesto

describe("A13 · ninguna función permite actuar sobre otra organización", () => {
  it("cada función del registro, llamada por Ana con la cabecera de B o sin cabecera, no toca a B", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const before = new Map<string, string>();
    for (const spec of ISOLATION_TABLES) before.set(spec.name, await fingerprint(db, spec));

    for (const [name, spec] of Object.entries(RPC_CASES)) {
      for (const header of [fx.orgs.B.tenantId, undefined]) {
        const res = await rpc(token, name, spec.args, tenantHeader(header));
        // Nunca devuelve datos de B
        expect(res.text, `${name}`).not.toContain(fx.orgs.B.canary);
        expect(res.text, `${name}`).not.toContain(fx.orgs.B.tenantId);
        if (spec.writesActiveTenant) {
          expect(
            res.status,
            `${name} debe rechazar sin organización propia activa`,
          ).toBeGreaterThanOrEqual(400);
        }
      }
    }
    for (const spec of ISOLATION_TABLES) {
      // `legal_acceptances` y `tenants` de B no cambian; las tablas de Ana pueden crecer (create_tenant, aceptaciones)
      expect(await fingerprint(db, spec), `${spec.name} cambió`).toBe(before.get(spec.name));
    }
  });

  it("las funciones no aceptan un tenant_id como argumento (la organización sale de la membresía)", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const [name, spec] of Object.entries(RPC_CASES)) {
      const res = await rpc(token, name, {
        ...spec.args,
        p_tenant_id: fx.orgs.B.tenantId,
        tenant_id: fx.orgs.B.tenantId,
      });
      expect(
        res.status,
        `${name} no debe aceptar una organización en los argumentos`,
      ).toBeGreaterThanOrEqual(400);
    }
  });

  it("create_tenant crea una organización NUEVA de quien llama; nunca entra a una existente", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const res = await rpc(
      token,
      "create_tenant",
      { p_name: "Otro negocio de Ana", p_rut: "76086428-5" },
      tenantHeader(fx.orgs.B.tenantId),
    );
    expect(res.status, res.text).toBe(200);
    const created = res.json as string;
    expect([fx.orgs.A.tenantId, fx.orgs.B.tenantId, fx.orgs.C.tenantId]).not.toContain(created);
    expect(await countWhere(db, "members", `tenant_id = '${created}'`)).toBe(1);
    expect(
      await countWhere(
        db,
        "members",
        `tenant_id = '${fx.orgs.B.tenantId}' and user_id = '${fx.personas.ana.userId}'`,
      ),
    ).toBe(0);
  });

  it("sin sesión, ninguna función responde", async () => {
    const fx = fixture();
    for (const [name, spec] of Object.entries(RPC_CASES)) {
      const res = await rpc(null, name, spec.args, tenantHeader(fx.orgs.A.tenantId));
      expect(res.status, name).toBeGreaterThanOrEqual(400);
    }
  });

  it("las funciones del servidor (límite de intentos) no las llama nadie con un pase", async () => {
    const args: Record<string, object> = {
      auth_limit_locked_until: { p_scope: "login_ip", p_key_hash: "0".repeat(64) },
      auth_limit_record_failure: {
        p_scope: "login_ip",
        p_key_hash: "0".repeat(64),
        p_max_failures: 1,
        p_window_seconds: 1,
        p_lock_seconds: 1,
      },
      auth_limit_clear: { p_scope: "login_ip", p_key_hash: "0".repeat(64) },
      record_email_event: {
        p_provider: "memory",
        p_provider_message_id: "no-existe",
        p_event: "delivered",
        p_occurred_at: null,
        p_bounce_type: null,
      },
      share_link_read: { p_token_sha256: "0".repeat(64) },
      share_link_record_view: {
        p_token_sha256: "0".repeat(64),
        p_ip_enc: null,
        p_user_agent: null,
      },
      share_link_respond: {
        p_token_sha256: "0".repeat(64),
        p_response_id: randomUUID(),
        p_response_key: randomUUID(),
        p_decision: "accepted",
        p_acceptor_name_enc: "x",
        p_reason_code: null,
        p_reason_text_enc: null,
        p_ip_enc: null,
        p_origin_ip: null,
        p_user_agent: null,
        p_acceptance_text_version: "v1",
      },
      share_notice_recipients: {
        p_quote_id: randomUUID(),
        p_response_id: randomUUID(),
      },
      internal_notice_register: {
        p_email_id: randomUUID(),
        p_quote_id: randomUUID(),
        p_response_id: randomUUID(),
        p_to_user_id: randomUUID(),
        p_to_email_enc: "x",
        p_to_email_hash: "0".repeat(64),
      },
      internal_notice_settle: {
        p_email_id: randomUUID(),
        p_provider: "memory",
        p_provider_message_id: "x",
        p_error_code: null,
      },
      // Sprint 4 · formulario público
      intake_form_read: { p_public_id: "A".repeat(22) },
      intake_request_submit: {
        p_public_id: "A".repeat(22),
        p_request_id: randomUUID(),
        p_submit_key: randomUUID(),
        p_form_revision: 1,
        p_contact_name_enc: "x",
        p_contact_email_enc: "x",
        p_contact_phone_enc: null,
        p_company_enc: null,
        p_comuna_enc: null,
        p_service_address_enc: null,
        p_message_enc: null,
        p_contact_email_hash: "0".repeat(64),
        p_desired_date: null,
        p_items: [{ form_item_id: randomUUID(), quantity_milli: null }],
        p_consent_template_version: "intake-v1",
        p_consent_text: "Acepto que la organización use mis datos para responder esta solicitud.",
        p_consent_ip_enc: null,
      },
      intake_record_block: { p_public_id: "A".repeat(22), p_reason: "rate" },
      intake_notice_recipients: {
        p_request_id: randomUUID(),
        p_kind: "request_received",
        p_form_id: null,
      },
      intake_notice_register: {
        p_email_id: randomUUID(),
        p_request_id: randomUUID(),
        p_kind: "request_received",
        p_to_user_id: randomUUID(),
        p_to_email_enc: "x",
        p_to_email_hash: "0".repeat(64),
        p_form_id: null,
      },
      intake_notice_settle: {
        p_email_id: randomUUID(),
        p_provider: "memory",
        p_provider_message_id: "x",
        p_error_code: null,
      },
      // Sprint 5 · invitaciones
      invitation_email_settle: {
        p_email_id: randomUUID(),
        p_provider: "memory",
        p_provider_message_id: "x",
        p_error_code: null,
      },
      invitation_notice_recipients: { p_invitation_id: randomUUID() },
      invitation_notice_register: {
        p_email_id: randomUUID(),
        p_invitation_id: randomUUID(),
        p_to_user_id: randomUUID(),
        p_to_email_enc: "x",
        p_to_email_hash: "0".repeat(64),
      },
    };
    for (const name of SERVER_ONLY_FUNCTIONS) {
      for (const token of [null, await tokenOf("ana")]) {
        const res = await rpc(token, name, args[name]);
        expect(res.status, `${name} ${token ? "con pase" : "anónimo"}`).toBeGreaterThanOrEqual(400);
      }
    }
  });
});

describe("A13b · quien está en dos organizaciones cambia la numeración de una sin tocar la otra", () => {
  it("Mixta cambia el prefijo en A y B queda como estaba; luego al revés", async () => {
    const fx = fixture();
    const token = await tokenOf("mixta");
    const settings = (tenantId: string) =>
      db.query<{ prefix: string }>(
        `select prefix from public.numbering_settings where tenant_id = $1`,
        [tenantId],
      );
    expect((await settings(fx.orgs.B.tenantId)).rows[0].prefix).toBe(NUMBERING_PREFIX.B);

    const inA = await rpc(
      token,
      "set_numbering",
      { p_prefix: "MXA", p_mode: "yearly" },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(inA.status, inA.text).toBe(200);
    expect((await settings(fx.orgs.A.tenantId)).rows[0].prefix).toBe("MXA");
    expect((await settings(fx.orgs.B.tenantId)).rows[0].prefix).toBe(NUMBERING_PREFIX.B);

    const inB = await rpc(
      token,
      "set_numbering",
      { p_prefix: "MXB", p_mode: "yearly" },
      tenantHeader(fx.orgs.B.tenantId),
    );
    expect(inB.status, inB.text).toBe(200);
    expect((await settings(fx.orgs.B.tenantId)).rows[0].prefix).toBe("MXB");
    expect((await settings(fx.orgs.A.tenantId)).rows[0].prefix).toBe("MXA");

    // la vista previa también es de la organización activa
    const previewA = await rpc(
      token,
      "preview_next_quote_number",
      {},
      tenantHeader(fx.orgs.A.tenantId),
    );
    const previewB = await rpc(
      token,
      "preview_next_quote_number",
      {},
      tenantHeader(fx.orgs.B.tenantId),
    );
    expect(previewA.json).toMatch(/^MXA-/);
    expect(previewB.json).toMatch(/^MXB-/);

    // se deja como estaba
    await rpc(
      token,
      "set_numbering",
      { p_prefix: NUMBERING_PREFIX.A, p_mode: "yearly" },
      tenantHeader(fx.orgs.A.tenantId),
    );
    await rpc(
      token,
      "set_numbering",
      { p_prefix: NUMBERING_PREFIX.B, p_mode: "yearly" },
      tenantHeader(fx.orgs.B.tenantId),
    );
  });

  it("Ana, con la cabecera de B, no puede cambiar la numeración de B ni ver su vista previa", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const set = await rpc(
      token,
      "set_numbering",
      { p_prefix: "HACK", p_mode: "yearly", p_start_number: 99999 },
      tenantHeader(fx.orgs.B.tenantId),
    );
    expect(set.status).toBeGreaterThanOrEqual(400);
    const preview = await rpc(
      token,
      "preview_next_quote_number",
      {},
      tenantHeader(fx.orgs.B.tenantId),
    );
    expect(preview.json).toBeNull();
    expect(await countWhere(db, "numbering_settings", `prefix = 'HACK'`)).toBe(0);
  });
});

describe("A14 · el esquema interno (app) no se alcanza desde la API", () => {
  it("allocate_quote_number y las demás funciones de app no existen para PostgREST", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const args = { p_tenant: fx.orgs.B.tenantId };
    const plain = await rpc(token, "allocate_quote_number", args, tenantHeader(fx.orgs.B.tenantId));
    expect([404, 400]).toContain(plain.status);
    const viaProfile = await rest(token, "rpc/allocate_quote_number", {
      method: "POST",
      body: args,
      headers: { "content-profile": "app" },
    });
    expect(viaProfile.status).toBe(NOT_EXPOSED_STATUS);
    for (const fn of ["current_tenant_id", "my_tenant_ids", "has_role"]) {
      const res = await rest(token, `rpc/${fn}`, {
        method: "POST",
        body: {},
        headers: { "content-profile": "app" },
      });
      expect(res.status, fn).toBe(NOT_EXPOSED_STATUS);
    }
  });

  it("los esquemas internos y los de Auth tampoco se leen como tablas", async () => {
    const token = await tokenOf("ana");
    for (const schema of ["app", "auth", "storage", "extensions", "pg_catalog"]) {
      const res = await rest(token, "users?select=*", { headers: { "accept-profile": schema } });
      expect(res.status, schema).toBe(NOT_EXPOSED_STATUS);
    }
  });
});

describe("A15 · el contador de numeración no baja ni lo toca nadie con un pase", () => {
  it("editar o crear numbering_sequences por la API es rechazado y el contador no cambia", async () => {
    const fx = fixture();
    const sequences = ISOLATION_TABLES.find((t) => t.name === "numbering_sequences")!;
    const beforeB = await fingerprint(db, sequences);
    const { rows: beforeA } = await db.query(
      `select last_number from public.numbering_sequences where tenant_id = $1 order by scope`,
      [fx.orgs.A.tenantId],
    );
    for (const persona of ["ana", "mixta"] as const) {
      const token = await tokenOf(persona);
      for (const org of [fx.orgs.A.tenantId, fx.orgs.B.tenantId]) {
        const patch = await rest(token, `numbering_sequences?tenant_id=eq.${org}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation", ...tenantHeader(org) },
          body: { last_number: 0 },
        });
        expect(isRejectedOrEmpty(patch), `${persona} ${org}: ${patch.status}`).toBe(true);
        const del = await rest(token, `numbering_sequences?tenant_id=eq.${org}`, {
          method: "DELETE",
          headers: tenantHeader(org),
        });
        expect(del.status >= 400 || (del.json as unknown[] | null)?.length === 0).toBe(true);
      }
    }
    const { rows: afterA } = await db.query(
      `select last_number from public.numbering_sequences where tenant_id = $1 order by scope`,
      [fx.orgs.A.tenantId],
    );
    expect(afterA).toEqual(beforeA);
    expect(await fingerprint(db, sequences)).toBe(beforeB);
  });
});

describe("A16 · la auditoría de otras organizaciones y de la plataforma no se ve", () => {
  it("Ana ve su propia auditoría y nunca la de B ni los registros de la plataforma", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const own = await rest(token, "audit_log?select=id,tenant_id,action", {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    const rows = own.json as { id: number; tenant_id: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === fx.orgs.A.tenantId)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain(fx.platformAuditId);

    for (const persona of ["ana", "beto", "mixta"] as const) {
      const platform = await rest(
        await tokenOf(persona),
        `audit_log?id=eq.${fx.platformAuditId}&select=*`,
        {
          headers: tenantHeader(fx.orgs.A.tenantId),
        },
      );
      expect(platform.json, persona).toEqual([]);
    }
  });

  it("un miembro sin rol de administración (lector) no ve la auditoría ni de su propia organización", async () => {
    const fx = fixture();
    const res = await rest(await tokenOf("dante"), "audit_log?select=id", {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect(res.json).toEqual([]);
  });
});

describe("X6 · los servicios de Auth no sirven para llegar a datos ajenos", () => {
  it("la API de administración de usuarios no responde a un pase de persona", async () => {
    const fx = fixture();
    const { apiUrl, publishableKey } = localEnv();
    const token = await tokenOf("ana");
    for (const path of [
      "/auth/v1/admin/users",
      `/auth/v1/admin/users/${fx.personas.beto.userId}`,
    ]) {
      const res = await fetch(`${apiUrl}${path}`, {
        headers: { apikey: publishableKey, authorization: `Bearer ${token}` },
      });
      expect([401, 403], path).toContain(res.status);
      expect(await res.text()).not.toContain(fx.personas.beto.email);
    }
  });

  it("/auth/v1/user solo devuelve a la propia persona", async () => {
    const fx = fixture();
    const { apiUrl, publishableKey } = localEnv();
    const res = await fetch(`${apiUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey, authorization: `Bearer ${await tokenOf("ana")}` },
    });
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(fx.personas.ana.userId);
  });
});

describe("pendientes de sprints futuros (se muestran en el informe, no se saltan)", () => {
  it.todo(
    "Búsqueda global (Ctrl + K): solo resultados de la organización activa (sprint 2, H-023)",
  );
  it.todo(
    "Exportación a Excel: solo filas de la organización activa y con auditoría (sprint 7, H-111)",
  );
  it.todo("Enlace del cliente: un token de B no abre una cotización de A (sprint 2, H-040)");
});
