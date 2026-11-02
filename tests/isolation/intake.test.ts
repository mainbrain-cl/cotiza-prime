// Sprint 4 · Ataques de aislamiento del formulario público y de las solicitudes (plan §7).
// Siempre con pases reales y `fetch` directo; la llave maestra solo sirve para montar y verificar.
import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptPii, PiiCryptoError } from "@/lib/crypto/pii";
import { rest, rpc } from "../support/local-supabase";
import { fingerprint, fixture, openDb, tenantHeader, tokenOf } from "./context";
import { ISOLATION_TABLES } from "./registry";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const codeOf = (res: { json: unknown }) => (res.json as { code?: string } | null)?.code;
const spec = (name: string) => ISOLATION_TABLES.find((t) => t.name === name)!;

describe("Ataque 1 · actuar sobre un formulario de B con el pase de A", () => {
  it("Ana guarda, publica, pausa y regenera el formulario de B: CP404 y B queda intacta", async () => {
    const fx = fixture();
    const b = fx.orgs.B.intake!;
    const token = await tokenOf("ana");
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const tables = ["intake_forms", "intake_form_items"].map(spec);
    const before = new Map<string, string>();
    for (const t of tables) before.set(t.name, await fingerprint(db, t));

    const calls: [string, object][] = [
      [
        "save_intake_form",
        {
          p_form_id: b.formId,
          p_expected_revision: b.revision,
          p_form: { title: "ATAQUE" },
          p_items: null,
        },
      ],
      [
        "save_intake_form",
        { p_form_id: b.formId, p_expected_revision: b.revision, p_form: {}, p_items: [] },
      ],
      ["set_intake_form_status", { p_form_id: b.formId, p_status: "paused" }],
      ["set_intake_form_status", { p_form_id: b.formId, p_status: "archived" }],
      ["regenerate_intake_form_public_id", { p_form_id: b.formId }],
    ];
    for (const [name, args] of calls) {
      const res = await rpc(token, name, args, headers);
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      expect(codeOf(res), `${name}: ${res.text}`).toBe("CP404");
      expect(res.text).not.toContain(fx.orgs.B.canary);
    }
    for (const t of tables) {
      expect(await fingerprint(db, t), `${t.name} cambió`).toBe(before.get(t.name));
    }
    const { rows } = await db.query<{ public_id: string; status: string }>(
      "select public_id, status from public.intake_forms where id = $1",
      [b.formId],
    );
    expect(rows[0]).toEqual({ public_id: b.publicId, status: "published" });
  });

  it("con la cabecera de B (o sin ninguna) Ana ni siquiera llega a las funciones: 42501", async () => {
    const fx = fixture();
    const b = fx.orgs.B.intake!;
    const token = await tokenOf("ana");
    for (const header of [fx.orgs.B.tenantId, undefined]) {
      for (const [name, args] of [
        ["create_intake_form", { p_form_id: b.formId, p_name: "ATAQUE" }],
        ["set_intake_form_status", { p_form_id: b.formId, p_status: "paused" }],
        ["regenerate_intake_form_public_id", { p_form_id: b.formId }],
      ] as [string, object][]) {
        const res = await rpc(token, name, args, tenantHeader(header));
        expect(res.status, name).toBeGreaterThanOrEqual(400);
        expect(codeOf(res), `${name}: ${res.text}`).toBe("42501");
      }
    }
  });

  it("Dante (lector de A) no puede crear ni editar los formularios de A; Beto tampoco con la cabecera de A", async () => {
    const fx = fixture();
    const a = fx.orgs.A.intake!;
    for (const persona of ["dante", "beto"] as const) {
      const token = await tokenOf(persona);
      const headers = tenantHeader(fx.orgs.A.tenantId);
      for (const [name, args] of [
        [
          "save_intake_form",
          {
            p_form_id: a.formId,
            p_expected_revision: a.revision,
            p_form: { title: "X" },
            p_items: null,
          },
        ],
        ["set_intake_form_status", { p_form_id: a.formId, p_status: "paused" }],
        ["regenerate_intake_form_public_id", { p_form_id: a.formId }],
      ] as [string, object][]) {
        const res = await rpc(token, name, args, headers);
        expect(res.status, `${persona} ${name}`).toBeGreaterThanOrEqual(400);
        expect(codeOf(res), `${persona} ${name}: ${res.text}`).toBe("42501");
      }
    }
  });
});

describe("H-086 · las lecturas del editor de formularios no cruzan organizaciones", () => {
  it("Ana pide el formulario de B (y sus servicios) con la cabecera de A: no hay filas", async () => {
    const fx = fixture();
    const b = fx.orgs.B.intake!;
    const token = await tokenOf("ana");
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const form = await rest(token, `intake_forms?select=id,title,fields&id=eq.${b.formId}`, {
      headers,
    });
    expect(form.json).toEqual([]);
    const items = await rest(
      token,
      `intake_form_items?select=id,public_name&form_id=eq.${b.formId}`,
      { headers },
    );
    expect(items.json).toEqual([]);
    const own = await rest(token, `intake_forms?select=id&id=eq.${fx.orgs.A.intake!.formId}`, {
      headers,
    });
    expect((own.json as unknown[]).length).toBe(1);
  });
});

describe("Ataque 3 · un servicio del catálogo de B dentro de un formulario de A", () => {
  it("Ana guarda su formulario con el `catalog_item_id` de B: se rechaza y el formulario de A no cambia", async () => {
    const fx = fixture();
    const a = fx.orgs.A.intake!;
    const token = await tokenOf("ana");
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const { rows: before } = await db.query(
      "select count(*)::int as n from public.intake_form_items where form_id = $1",
      [a.formId],
    );
    const res = await rpc(
      token,
      "save_intake_form",
      {
        p_form_id: a.formId,
        p_expected_revision: a.revision,
        p_form: {},
        p_items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            kind: "catalog",
            catalog_item_id: fx.orgs.B.catalogIds[0],
            public_name: "ATAQUE",
            unit: "service",
          },
        ],
      },
      headers,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(res), res.text).toBe("CP404");
    expect(res.text).not.toContain(fx.orgs.B.canary);
    const { rows } = await db.query(
      "select count(*)::int as n from public.intake_form_items where form_id = $1",
      [a.formId],
    );
    expect(rows[0].n).toBe(before[0].n);
    const leaked = await db.query(
      "select 1 from public.intake_form_items where catalog_item_id = $1 and tenant_id <> $2",
      [fx.orgs.B.catalogIds[0], fx.orgs.B.tenantId],
    );
    expect(leaked.rows).toEqual([]);
  });

  it("Ana reusa el identificador de un servicio de B en su formulario: se rechaza y el de B sigue en B", async () => {
    const fx = fixture();
    const a = fx.orgs.A.intake!;
    const b = fx.orgs.B.intake!;
    const res = await rpc(
      await tokenOf("ana"),
      "save_intake_form",
      {
        p_form_id: a.formId,
        p_expected_revision: a.revision,
        p_form: {},
        p_items: [{ id: b.freeItemId, kind: "free", public_name: "ATAQUE", unit: "service" }],
      },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await db.query<{ tenant_id: string; form_id: string }>(
      "select tenant_id, form_id from public.intake_form_items where id = $1",
      [b.freeItemId],
    );
    expect(rows[0]).toEqual({ tenant_id: fx.orgs.B.tenantId, form_id: b.formId });
  });
});

describe("Ataque 6 · lo que ningún pase puede leer", () => {
  it("nadie pide la IP cifrada del consentimiento, ni con `select=*` ni filtrando por ella", async () => {
    const fx = fixture();
    const headers = tenantHeader(fx.orgs.A.tenantId);
    for (const persona of ["ana", "mixta", "dante"] as const) {
      const token = await tokenOf(persona);
      for (const query of [
        "intake_requests?select=consent_ip_enc",
        "intake_requests?select=*",
        "intake_requests?select=id&consent_ip_enc=not.is.null",
        "intake_requests?select=id&order=consent_ip_enc",
      ]) {
        const res = await rest(token, query, { headers });
        expect(res.status, `${persona} ${query}`).toBeGreaterThanOrEqual(400);
        expect(res.text).not.toMatch(/"v1\.[A-Za-z0-9_-]{16}/); // ningún dato cifrado
      }
    }
  });

  it("nadie con pase lee `daily_cap` por la tabla: ni el Dueño, ni con `select=*`, ni filtrando u ordenando por él", async () => {
    const fx = fixture();
    const headers = tenantHeader(fx.orgs.A.tenantId);
    for (const persona of ["ana", "mixta", "dante"] as const) {
      const token = await tokenOf(persona);
      for (const query of [
        "intake_forms?select=daily_cap",
        "intake_forms?select=*",
        "intake_forms?select=id&daily_cap=gte.1",
        "intake_forms?select=id&order=daily_cap",
      ]) {
        const res = await rest(token, query, { headers });
        expect(res.status, `${persona} ${query}`).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it("el tope lo lee por la función solo el Dueño o el Administrador, y solo el de su organización", async () => {
    const fx = fixture();
    const a = fx.orgs.A.intake!;
    const b = fx.orgs.B.intake!;
    const headers = tenantHeader(fx.orgs.A.tenantId);
    const { rows } = await db.query<{ id: string; daily_cap: number }>(
      "select id, daily_cap from public.intake_forms where tenant_id = $1",
      [fx.orgs.A.tenantId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const persona of ["ana", "mixta"] as const) {
      const token = await tokenOf(persona);
      const all = await rpc(token, "intake_form_daily_caps", {}, headers);
      expect(all.status, `${persona}: ${all.text}`).toBe(200);
      const got = (all.json as { form_id: string; daily_cap: number }[]).map((r) => [
        r.form_id,
        r.daily_cap,
      ]);
      expect(got.sort()).toEqual(rows.map((r) => [r.id, r.daily_cap]).sort());
      expect(all.text).not.toContain(b.formId);
      const one = await rpc(token, "intake_form_daily_caps", { p_form_id: a.formId }, headers);
      expect(one.status, one.text).toBe(200);
      expect((one.json as unknown[]).length).toBe(1);
    }
    // El Observador de A (rol sin permiso) recibe «prohibido».
    const dante = await rpc(await tokenOf("dante"), "intake_form_daily_caps", {}, headers);
    expect(dante.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(dante)).toBe("42501");
  });

  it("Ana pide el tope del formulario de B: con la cabecera de A recibe «No encontrado» (CP404); con la de B o sin cabecera, 42501", async () => {
    const fx = fixture();
    const b = fx.orgs.B.intake!;
    const token = await tokenOf("ana");
    const own = await rpc(
      token,
      "intake_form_daily_caps",
      { p_form_id: b.formId },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(own.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(own), own.text).toBe("CP404");
    for (const header of [fx.orgs.B.tenantId, undefined]) {
      const res = await rpc(
        token,
        "intake_form_daily_caps",
        { p_form_id: b.formId },
        tenantHeader(header),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(codeOf(res), res.text).toBe("42501");
    }
  });

  it("un Lector no ve los contadores del día; el Dueño ve los de A y no los de B", async () => {
    const fx = fixture();
    const query = "intake_daily_counters?select=tenant_id,form_id,accepted,blocked_rate";
    const dante = await rest(await tokenOf("dante"), query, {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect(dante.json).toEqual([]);
    const ana = await rest(await tokenOf("ana"), query, {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    const rows = ana.json as { tenant_id: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === fx.orgs.A.tenantId)).toBe(true);
    const crossed = await rest(
      await tokenOf("ana"),
      `${query}&tenant_id=eq.${fx.orgs.B.tenantId}`,
      {
        headers: tenantHeader(fx.orgs.A.tenantId),
      },
    );
    expect(crossed.json).toEqual([]);
  });

  it("los datos de contacto de las solicitudes de A los leen los miembros de A, no los de B", async () => {
    const fx = fixture();
    const query = "intake_requests?select=id,contact_name_enc,contact_email_enc,items";
    for (const persona of ["ana", "dante"] as const) {
      const res = await rest(await tokenOf(persona), query, {
        headers: tenantHeader(fx.orgs.A.tenantId),
      });
      expect(res.status, persona).toBe(200);
      const rows = res.json as { id: string }[];
      expect(rows.map((r) => r.id)).toContain(fx.orgs.A.intake!.requestId);
      expect(rows.map((r) => r.id)).not.toContain(fx.orgs.B.intake!.requestId);
    }
    const beto = await rest(await tokenOf("beto"), query, {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect(beto.json).toEqual([]);
  });
});

describe("Ataque 7 · un dato cifrado copiado a otra fila no se abre", () => {
  it("el correo cifrado de la solicitud de B, copiado a una fila de A, falla por el sello", async () => {
    const fx = fixture();
    const a = fx.orgs.A.intake!;
    const b = fx.orgs.B.intake!;
    const { rows } = await db.query<{ contact_email_enc: string }>(
      "select contact_email_enc from public.intake_requests where id = $1",
      [b.requestId],
    );
    const encrypted = rows[0].contact_email_enc;
    const seal = (tenantId: string, rowId: string, field = "contact_email") => ({
      table: "intake_requests",
      field,
      tenantId,
      rowId,
    });
    // control positivo: con su propio sello, se abre
    expect(decryptPii(encrypted, seal(fx.orgs.B.tenantId, b.requestId))).toBe(b.contactEmail);

    // copiado a una fila nueva de A (en una transacción que se deshace)
    const copyId = randomUUID();
    await db.query("begin");
    try {
      await db.query(
        `insert into public.intake_requests
           (id, tenant_id, form_id, contact_name_enc, contact_email_enc, contact_email_hash, items,
            form_revision, submit_key, consent_template_version, consent_text, consent_text_sha256)
         values ($1, $2, $3, 'v1.x.x', $4, $5, $6::jsonb, 1, gen_random_uuid(), 'intake-v1', $7, $8)`,
        [
          copyId,
          fx.orgs.A.tenantId,
          a.formId,
          encrypted,
          "c".repeat(64),
          JSON.stringify([{ form_item_id: a.freeItemId, name: "copia", unit: "unit" }]),
          "Acepto que la organización use mis datos para responder esta solicitud.",
          createHash("sha256")
            .update("Acepto que la organización use mis datos para responder esta solicitud.")
            .digest("hex"),
        ],
      );
      const copied = await db.query<{ contact_email_enc: string }>(
        "select contact_email_enc from public.intake_requests where id = $1",
        [copyId],
      );
      for (const sealed of [
        seal(fx.orgs.A.tenantId, copyId),
        seal(fx.orgs.B.tenantId, copyId),
        seal(fx.orgs.A.tenantId, b.requestId),
        seal(fx.orgs.B.tenantId, b.requestId, "contact_name"),
      ]) {
        expect(() => decryptPii(copied.rows[0].contact_email_enc, sealed)).toThrow(PiiCryptoError);
      }
    } finally {
      await db.query("rollback");
    }
  });
});
