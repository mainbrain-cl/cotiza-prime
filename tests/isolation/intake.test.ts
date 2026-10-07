// Sprint 4 · Ataques de aislamiento del formulario público y de las solicitudes (plan §7).
// Siempre con pases reales y `fetch` directo; la llave maestra solo sirve para montar y verificar.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpc } from "../support/local-supabase";
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
