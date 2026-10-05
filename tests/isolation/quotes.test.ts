// H-025 / H-026 · Cotizaciones frente a otra organización (se suma a las tablas, funciones y rutas
// del registro). Con pases reales y `fetch` directo; la verificación posterior es con `pg`: las filas
// de B quedan idénticas.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rest, rpc } from "../support/local-supabase";
import {
  countWhere,
  fingerprint,
  fixture,
  isRejectedOrEmpty,
  openDb,
  tenantHeader,
  tokenOf,
} from "./context";
import { ISOLATION_TABLES } from "./registry";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const spec = (name: string) => ISOLATION_TABLES.find((t) => t.name === name)!;

const emptyDraft = (customerId: string, revision = 1) => ({
  p_expected_revision: revision,
  p_save_id: randomUUID(),
  p_header: { customer_id: customerId, global_discount: { kind: "none", value: 0 } },
  p_items: [],
  p_expected_totals: {
    lines: [],
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
  },
});

async function bQuoteFingerprints() {
  return Promise.all(
    ["quotes", "quote_items", "quote_events"].map((name) => fingerprint(db, spec(name))),
  );
}

describe("cotizaciones · escritura por las funciones", () => {
  it("Ana, con A o con B o sin organización, no puede guardar la cotización de B (B idéntica)", async () => {
    const fx = fixture();
    const before = await bQuoteFingerprints();
    const token = await tokenOf("ana");
    for (const header of [fx.orgs.A.tenantId, fx.orgs.B.tenantId, undefined]) {
      const res = await rpc(
        token,
        "save_quote_draft",
        { p_quote_id: fx.orgs.B.quoteIds[0], ...emptyDraft(fx.orgs.A.customerIds[0]) },
        tenantHeader(header),
      );
      expect(res.status, `${header ?? "sin cabecera"}: ${res.text}`).toBeGreaterThanOrEqual(400);
      expect(res.text).not.toContain(fx.orgs.B.canary);
    }
    expect(await bQuoteFingerprints()).toEqual(before);
  });

  it("Mixta, con la cabecera de A, no puede guardar la cotización de B (B idéntica)", async () => {
    const fx = fixture();
    const before = await bQuoteFingerprints();
    const res = await rpc(
      await tokenOf("mixta"),
      "save_quote_draft",
      { p_quote_id: fx.orgs.B.quoteIds[0], ...emptyDraft(fx.orgs.A.customerIds[0]) },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).toContain("CP404");
    expect(await bQuoteFingerprints()).toEqual(before);
  });

  it("Ana no puede crear una cotización con un cliente de B ni guardar la suya con un cliente de B", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const quotesBefore = await countWhere(db, "quotes", `tenant_id = '${fx.orgs.A.tenantId}'`);
    const create = await rpc(
      token,
      "create_quote",
      { p_customer_id: fx.orgs.B.customerIds[0], p_creation_key: randomUUID() },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(create.status).toBeGreaterThanOrEqual(400);
    expect(create.text).not.toContain(fx.orgs.B.canary);
    expect(await countWhere(db, "quotes", `tenant_id = '${fx.orgs.A.tenantId}'`)).toBe(
      quotesBefore,
    );

    // con la revisión vigente: el rechazo tiene que ser por el cliente, no por un choque de revisión
    const current = await db.query<{ revision: number }>(
      "select revision from public.quotes where id = $1",
      [fx.orgs.A.quoteIds[0]],
    );
    const save = await rpc(
      token,
      "save_quote_draft",
      {
        p_quote_id: fx.orgs.A.quoteIds[0],
        ...emptyDraft(fx.orgs.B.customerIds[0], current.rows[0].revision),
      },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(save.status).toBeGreaterThanOrEqual(400);
    expect(save.text).toContain("CP422");
    expect(
      await countWhere(
        db,
        "quotes",
        `id = '${fx.orgs.A.quoteIds[0]}' and customer_id = '${fx.orgs.B.customerIds[0]}'`,
      ),
    ).toBe(0);
  });

  it("un servicio de B no entra a una cotización de A", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const { rows } = await db.query<{ revision: number }>(
      "select revision from public.quotes where id = $1",
      [fx.orgs.A.quoteIds[0]],
    );
    const draft = emptyDraft(fx.orgs.A.customerIds[0]);
    const res = await rpc(
      token,
      "save_quote_draft",
      {
        p_quote_id: fx.orgs.A.quoteIds[0],
        ...draft,
        p_expected_revision: rows[0].revision,
        p_items: [
          {
            id: randomUUID(),
            catalog_item_id: fx.orgs.B.catalogIds[0],
            name: "Intento",
            unit: "service",
            tax_treatment: "taxable",
            quantity_milli: 1000,
            unit_price_clp: 10_000,
            discount_kind: "none",
            discount_value: 0,
          },
        ],
      },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain(fx.orgs.B.canary);
  });

  it("Mixta (administradora de A) no edita el borrador de Ana; el lector no crea", async () => {
    const fx = fixture();
    const before = await fingerprint(db, spec("quotes"));
    const mixta = await rpc(
      await tokenOf("mixta"),
      "save_quote_draft",
      { p_quote_id: fx.orgs.A.quoteIds[0], ...emptyDraft(fx.orgs.A.customerIds[0]) },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(mixta.status).toBeGreaterThanOrEqual(400);
    for (const persona of ["dante"] as const) {
      const res = await rpc(
        await tokenOf(persona),
        "create_quote",
        { p_customer_id: fx.orgs.A.customerIds[0], p_creation_key: randomUUID() },
        tenantHeader(fx.orgs.A.tenantId),
      );
      expect(res.status, persona).toBeGreaterThanOrEqual(400);
    }
    expect(await fingerprint(db, spec("quotes"))).toBe(before);
  });
});

describe("cotizaciones · lectura y escritura directa", () => {
  it("pedir el costo de las líneas (unit_cost_clp) es rechazado, aun para su propia organización", async () => {
    const fx = fixture();
    for (const persona of ["ana", "mixta"] as const) {
      const res = await rest(await tokenOf(persona), "quote_items?select=id,unit_cost_clp", {
        headers: tenantHeader(fx.orgs.A.tenantId),
      });
      expect(res.status, persona).toBeGreaterThanOrEqual(400);
      const star = await rest(await tokenOf(persona), "quote_items?select=*", {
        headers: tenantHeader(fx.orgs.A.tenantId),
      });
      expect(star.status, persona).toBeGreaterThanOrEqual(400);
    }
  });

  it("las líneas y la historia de B no salen a Ana, ni por identificador ni embebidas", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const header of [fx.orgs.A.tenantId, fx.orgs.B.tenantId]) {
      for (const path of [
        `quotes?id=eq.${fx.orgs.B.quoteIds[0]}&select=id,number_display`,
        `quote_items?quote_id=eq.${fx.orgs.B.quoteIds[0]}&select=id,name`,
        `quote_events?quote_id=eq.${fx.orgs.B.quoteIds[0]}&select=id,type,data`,
        `quotes?select=id,quote_items(id,name),quote_events(id,type)`,
        `customers?select=id,quotes(id,number_display)&id=eq.${fx.orgs.B.customerIds[0]}`,
      ]) {
        const res = await rest(token, path, { headers: tenantHeader(header) });
        expect(res.text, path).not.toContain(fx.orgs.B.canary);
        expect(res.text, path).not.toContain(fx.orgs.B.quoteIds[0]);
      }
    }
  });

  it("Ana, con su organización, ve sus cotizaciones y líneas (control positivo)", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const quotes = await rest(token, "quotes?select=id,number_display,status,total_clp", {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    const rows = quotes.json as { id: string; total_clp: number }[];
    expect(rows.map((r) => r.id)).toContain(fx.orgs.A.quoteIds[0]);
    const items = await rest(
      token,
      `quote_items?quote_id=eq.${fx.orgs.A.quoteIds[0]}&select=id,name`,
      {
        headers: tenantHeader(fx.orgs.A.tenantId),
      },
    );
    expect((items.json as unknown[]).length).toBe(2);
  });

  it("Ana no escribe ni sus propias cotizaciones por la API: solo por las funciones", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const before = await fingerprint(db, spec("quotes"));
    const headers = { Prefer: "return=representation", ...tenantHeader(fx.orgs.A.tenantId) };
    const patch = await rest(token, `quotes?id=eq.${fx.orgs.A.quoteIds[0]}`, {
      method: "PATCH",
      headers,
      body: { total_clp: 1 },
    });
    expect(isRejectedOrEmpty(patch)).toBe(true);
    const del = await rest(token, `quote_items?quote_id=eq.${fx.orgs.A.quoteIds[0]}`, {
      method: "DELETE",
      headers,
    });
    expect(isRejectedOrEmpty(del)).toBe(true);
    const event = await rest(token, "quote_events", {
      method: "POST",
      headers,
      body: {
        tenant_id: fx.orgs.A.tenantId,
        quote_id: fx.orgs.A.quoteIds[0],
        type: "x",
        actor_type: "user",
      },
    });
    expect(isRejectedOrEmpty(event)).toBe(true);
    expect(await fingerprint(db, spec("quotes"))).toBe(before);
    expect(await countWhere(db, "quote_items", `quote_id = '${fx.orgs.A.quoteIds[0]}'`)).toBe(2);
  });
});

// Migración 18 (H-027): vigencia, observaciones, condiciones y vigencia por defecto de la organización.
describe("cotizaciones · vigencia y textos (H-027)", () => {
  it("Ana no puede guardar vigencia ni textos en la cotización de B, con ninguna cabecera (B idéntica)", async () => {
    const fx = fixture();
    const before = await bQuoteFingerprints();
    const token = await tokenOf("ana");
    const draft = emptyDraft(fx.orgs.A.customerIds[0]);
    for (const header of [fx.orgs.A.tenantId, fx.orgs.B.tenantId, undefined]) {
      const res = await rpc(
        token,
        "save_quote_draft",
        {
          p_quote_id: fx.orgs.B.quoteIds[0],
          ...draft,
          p_header: {
            ...draft.p_header,
            validity: { mode: "days", days: 1 },
            observations: "texto de ataque",
            conditions: "texto de ataque",
          },
        },
        tenantHeader(header),
      );
      expect(res.status, `${header ?? "sin cabecera"}: ${res.text}`).toBeGreaterThanOrEqual(400);
      expect(res.text).not.toContain(fx.orgs.B.canary);
    }
    expect(await bQuoteFingerprints()).toEqual(before);
    expect(
      await countWhere(
        db,
        "quotes",
        `tenant_id = '${fx.orgs.B.tenantId}' and (observations = 'texto de ataque' or conditions = 'texto de ataque')`,
      ),
    ).toBe(0);
  });

  it("Ana no puede cambiar la vigencia por defecto de B ", async () => {
    const fx = fixture();
    const before = await db.query(
      "select tenant_id, default_validity_days from public.tenants where tenant_id = $1",
      [fx.orgs.B.tenantId],
    );
    const token = await tokenOf("ana");
    for (const header of [fx.orgs.A.tenantId, fx.orgs.B.tenantId, undefined]) {
      await rest(token, `tenants?tenant_id=eq.${fx.orgs.B.tenantId}`, {
        method: "PATCH",
        headers: { ...tenantHeader(header), prefer: "return=representation" },
        body: { default_validity_days: 1 },
      });
    }
    const after = await db.query(
      "select tenant_id, default_validity_days from public.tenants where tenant_id = $1",
      [fx.orgs.B.tenantId],
    );
    expect(after.rows).toEqual(before.rows);
  });
});
