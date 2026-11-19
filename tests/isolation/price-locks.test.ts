// 🟢 PRUEBAS · Supabase local, datos ficticios.
// Sprint 5 · H-041 etapa A · Aislamiento del tope de descuento y del precio bloqueado: ataques con pases reales y `fetch` directo.
//  1. Ana (A) apunta a B con su pase —cabecera de B, sin cabecera, mal escrita— para cambiar su tope: «No encontrado». El tope de B
//     (4.321 puntos base, el testigo numérico) no aparece en ninguna respuesta y no cambia.
//  2. Beto (Dueño de B) apunta a A; Mixta (Administradora de A y de B), parada en A, cambia A y no toca B; la auditoría queda en A.
//  3. Dante (Observador), Dario (Aprobador), Sofia y Ex (Comercial) no pueden fijar el tope de A.
//  4. Nadie con un pase escribe `max_discount_bp` directo, y el candado de un servicio de B no se cambia desde A.
//  5. Lectura: quien no es de B no ve el tope de B ni el candado de sus servicios; Beto sí los ve en su organización (control).
//  6. Guardar una cotización de A nombrando un servicio de B da el MISMO error esté o no bloqueado (no se averigua el candado ajeno).
//  7. A nivel de base: el tope y el candado se leen siempre de la organización que se pregunta.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rest, rpc } from "../support/local-supabase";
import { countWhere, fixture, openDb, tenantHeader, tokenOf } from "./context";
import { B_MAX_DISCOUNT_BP } from "./fixture";

let db: Client;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.end();
});

const codeOf = (res: { json: unknown }) => (res.json as { code?: string } | null)?.code;
const WITNESS = String(B_MAX_DISCOUNT_BP);

const setArgs = (value: number | null) => ({ p_max_bp: value });

async function capOf(tenantId: string): Promise<number | null> {
  const { rows } = await db.query<{ v: number | null }>(
    "select max_discount_bp as v from public.tenants where tenant_id = $1",
    [tenantId],
  );
  return rows[0].v;
}
const tenantAudits = (tenantId: string) =>
  countWhere(db, "audit_log", `tenant_id = '${tenantId}' and action = 'tenant.updated'`);
async function lockedOf(catalogId: string): Promise<boolean> {
  const { rows } = await db.query<{ v: boolean }>(
    "select price_locked as v from public.catalog_items where id = $1",
    [catalogId],
  );
  return rows[0].v;
}

describe("Ataque 1 · Ana, con su pase, apunta a B", () => {
  it("con la cabecera de B, sin cabecera o mal escrita: «No encontrado», el tope de B intacto y el testigo fuera de la respuesta", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const auditsBefore = await tenantAudits(fx.orgs.B.tenantId);
    const headers = [
      fx.orgs.B.tenantId,
      fx.orgs.B.tenantId.toUpperCase(),
      fx.orgs.B.tenantId.replaceAll("-", ""),
      `{${fx.orgs.B.tenantId}}`,
      undefined,
      "",
      "null",
    ];
    for (const header of headers) {
      const res = await rpc(token, "set_quote_max_discount", setArgs(1), tenantHeader(header));
      expect(res.status, `${header}`).toBeGreaterThanOrEqual(400);
      expect(codeOf(res), `${header}`).toBe("CP404");
      expect(res.text, `${header}`).not.toContain(fx.orgs.B.canary);
      expect(res.text, `${header}`).not.toContain(fx.orgs.B.tenantId);
      expect(res.text, `${header}`).not.toContain(WITNESS);
    }
    expect(await capOf(fx.orgs.B.tenantId)).toBe(B_MAX_DISCOUNT_BP);
    expect(await tenantAudits(fx.orgs.B.tenantId)).toBe(auditsBefore);
  });

  it("mandar un tenant_id como argumento no sirve: la función no lo acepta", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const res = await rpc(
      token,
      "set_quote_max_discount",
      { p_max_bp: 1, p_tenant_id: fx.orgs.B.tenantId, tenant_id: fx.orgs.B.tenantId },
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await capOf(fx.orgs.B.tenantId)).toBe(B_MAX_DISCOUNT_BP);
    expect(await capOf(fx.orgs.A.tenantId)).toBeNull();
  });
});

describe("Ataque 2 · entre organizaciones, en los dos sentidos", () => {
  it("Beto (Dueño de B) no toca el tope de A con la cabecera de A; con la suya, repetir su valor no cambia nada ni audita", async () => {
    const fx = fixture();
    const token = await tokenOf("beto");
    const asA = await rpc(
      token,
      "set_quote_max_discount",
      setArgs(1),
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(codeOf(asA)).toBe("CP404");
    expect(asA.text).not.toContain(fx.orgs.A.canary);
    expect(await capOf(fx.orgs.A.tenantId)).toBeNull();
    // control positivo: en su organización sí funciona, y el mismo valor no se reescribe
    const auditsBefore = await tenantAudits(fx.orgs.B.tenantId);
    const asB = await rpc(
      token,
      "set_quote_max_discount",
      setArgs(B_MAX_DISCOUNT_BP),
      tenantHeader(fx.orgs.B.tenantId),
    );
    expect(asB.status, asB.text).toBe(200);
    expect(asB.json).toEqual({ changed: false, max_discount_bp: B_MAX_DISCOUNT_BP });
    expect(await tenantAudits(fx.orgs.B.tenantId)).toBe(auditsBefore);
  });

  it("Mixta (Administradora de A y de B), parada en A, cambia A y no toca B; la auditoría queda en A", async () => {
    const fx = fixture();
    const token = await tokenOf("mixta");
    const auditsA = await tenantAudits(fx.orgs.A.tenantId);
    const auditsB = await tenantAudits(fx.orgs.B.tenantId);
    try {
      const res = await rpc(
        token,
        "set_quote_max_discount",
        setArgs(2_500),
        tenantHeader(fx.orgs.A.tenantId),
      );
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ changed: true, max_discount_bp: 2_500 });
      expect(await capOf(fx.orgs.A.tenantId)).toBe(2_500);
      expect(await capOf(fx.orgs.B.tenantId)).toBe(B_MAX_DISCOUNT_BP);
      expect(await tenantAudits(fx.orgs.A.tenantId)).toBe(auditsA + 1);
      expect(await tenantAudits(fx.orgs.B.tenantId)).toBe(auditsB);
      // la auditoría lleva el valor anterior y el nuevo, con el tenant_id de A
      const { rows } = await db.query<{ tenant_id: string; details: Record<string, unknown> }>(
        `select tenant_id, details from public.audit_log
          where tenant_id = $1 and action = 'tenant.updated' order by id desc limit 1`,
        [fx.orgs.A.tenantId],
      );
      expect(rows[0].tenant_id).toBe(fx.orgs.A.tenantId);
      expect(rows[0].details).toEqual({
        old: { max_discount_bp: null },
        new: { max_discount_bp: 2_500 },
      });
    } finally {
      // la fixture se comparte con los demás archivos: A vuelve a «sin tope»
      await rpc(token, "set_quote_max_discount", setArgs(null), tenantHeader(fx.orgs.A.tenantId));
    }
    expect(await capOf(fx.orgs.A.tenantId)).toBeNull();
  });

  it("Mixta parada en B (donde también es Administradora) cambia B y no toca A; vuelve a dejar el testigo", async () => {
    const fx = fixture();
    const token = await tokenOf("mixta");
    try {
      const res = await rpc(
        token,
        "set_quote_max_discount",
        setArgs(7_000),
        tenantHeader(fx.orgs.B.tenantId),
      );
      expect(res.status, res.text).toBe(200);
      expect(await capOf(fx.orgs.B.tenantId)).toBe(7_000);
      expect(await capOf(fx.orgs.A.tenantId)).toBeNull();
    } finally {
      await rpc(
        token,
        "set_quote_max_discount",
        setArgs(B_MAX_DISCOUNT_BP),
        tenantHeader(fx.orgs.B.tenantId),
      );
    }
    expect(await capOf(fx.orgs.B.tenantId)).toBe(B_MAX_DISCOUNT_BP);
  });
});

describe("Ataque 3 · quien no maneja el catálogo no fija el tope", () => {
  it("Dante (Observador), Dario (Aprobador) y Sofia (Comercial) reciben «sin permiso» (42501) en A, y A no cambia", async () => {
    const fx = fixture();
    const headers = tenantHeader(fx.orgs.A.tenantId);
    for (const persona of ["dante", "dario", "sofia"] as const) {
      const res = await rpc(await tokenOf(persona), "set_quote_max_discount", setArgs(1), headers);
      expect(res.status, persona).toBeGreaterThanOrEqual(400);
      expect(codeOf(res), persona).toBe("42501");
    }
    expect(await capOf(fx.orgs.A.tenantId)).toBeNull();
  });

  it("Ex (Comercial en A, o ya quitada por otra prueba) tampoco puede", async () => {
    const fx = fixture();
    const res = await rpc(
      await tokenOf("ex"),
      "set_quote_max_discount",
      setArgs(1),
      tenantHeader(fx.orgs.A.tenantId),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(["42501", "CP404"]).toContain(codeOf(res));
    expect(await capOf(fx.orgs.A.tenantId)).toBeNull();
  });

  it("fuera de rango: la Dueña recibe CP422 y no cambia nada", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const bad of [-1, 10_000]) {
      const res = await rpc(
        token,
        "set_quote_max_discount",
        setArgs(bad),
        tenantHeader(fx.orgs.A.tenantId),
      );
      expect(codeOf(res), String(bad)).toBe("CP422");
    }
    expect(await capOf(fx.orgs.A.tenantId)).toBeNull();
  });
});

describe("Ataque 4 · escribir directo", () => {
  it("nadie con un pase (ni la Dueña ni la Administradora) escribe `max_discount_bp` por la API de tablas", async () => {
    const fx = fixture();
    for (const [persona, tenantId] of [
      ["ana", fx.orgs.A.tenantId],
      ["mixta", fx.orgs.A.tenantId],
      ["beto", fx.orgs.B.tenantId],
    ] as const) {
      const res = await rest(await tokenOf(persona), `tenants?tenant_id=eq.${tenantId}`, {
        method: "PATCH",
        headers: { ...tenantHeader(tenantId), Prefer: "return=representation" },
        body: { max_discount_bp: 1 },
      });
      expect(res.status, persona).toBeGreaterThanOrEqual(400);
    }
    expect(await capOf(fx.orgs.A.tenantId)).toBeNull();
    expect(await capOf(fx.orgs.B.tenantId)).toBe(B_MAX_DISCOUNT_BP);
  });

  it("Ana, apuntando por su identificador al servicio bloqueado de B, no lo desbloquea ni con su cabecera ni con la de B", async () => {
    const fx = fixture();
    const lockedId = fx.orgs.B.lockedCatalogId!;
    expect(await lockedOf(lockedId)).toBe(true);
    for (const header of [fx.orgs.A.tenantId, fx.orgs.B.tenantId, undefined]) {
      const res = await rest(await tokenOf("ana"), `catalog_items?id=eq.${lockedId}`, {
        method: "PATCH",
        headers: { ...tenantHeader(header), Prefer: "return=representation" },
        body: { price_locked: false },
      });
      // la regla por fila no la deja ver: no se actualiza nada
      expect(res.status < 300 ? res.json : [], `${header}`).toEqual([]);
      expect(res.text).not.toContain(fx.orgs.B.canary);
    }
    expect(await lockedOf(lockedId)).toBe(true);
  });

  it("Sofia (Comercial de A) no bloquea ni desbloquea un servicio de A", async () => {
    const fx = fixture();
    const res = await rest(
      await tokenOf("sofia"),
      `catalog_items?id=eq.${fx.orgs.A.catalogIds[0]}`,
      {
        method: "PATCH",
        headers: { ...tenantHeader(fx.orgs.A.tenantId), Prefer: "return=representation" },
        body: { price_locked: true },
      },
    );
    expect(res.status < 300 ? res.json : [], "Sofia").toEqual([]);
    expect(await lockedOf(fx.orgs.A.catalogIds[0])).toBe(false);
  });
});

describe("Ataque 5 · lectura", () => {
  it("quien no es de B no ve el tope de B ni el candado de sus servicios, en ninguna respuesta", async () => {
    const fx = fixture();
    for (const persona of ["ana", "dante", "dario", "sofia"] as const) {
      const token = await tokenOf(persona);
      for (const header of [fx.orgs.A.tenantId, fx.orgs.B.tenantId, undefined]) {
        const tenants = await rest(token, "tenants?select=*", { headers: tenantHeader(header) });
        expect(tenants.status, persona).toBe(200);
        expect(tenants.text, `${persona} ${header}`).not.toContain(WITNESS);
        expect(tenants.text, `${persona} ${header}`).not.toContain(fx.orgs.B.tenantId);
        const catalog = await rest(token, "catalog_items?select=*", {
          headers: tenantHeader(header),
        });
        expect(catalog.text, `${persona} ${header}`).not.toContain(fx.orgs.B.canary);
        const rows = (catalog.json as { id: string }[] | null) ?? [];
        expect(
          rows.some((r) => r.id === fx.orgs.B.lockedCatalogId),
          `${persona} ${header}`,
        ).toBe(false);
      }
    }
  });

  it("cada miembro de A lee el tope de A (control: sin tope = null) y el candado de sus servicios", async () => {
    const fx = fixture();
    const headers = tenantHeader(fx.orgs.A.tenantId);
    for (const persona of ["ana", "mixta", "dante", "dario", "sofia"] as const) {
      const token = await tokenOf(persona);
      const tenants = await rest(
        token,
        `tenants?select=tenant_id,max_discount_bp&tenant_id=eq.${fx.orgs.A.tenantId}`,
        { headers },
      );
      expect(tenants.json, persona).toEqual([
        { tenant_id: fx.orgs.A.tenantId, max_discount_bp: null },
      ]);
      const catalog = await rest(
        token,
        `catalog_items?select=id,price_locked&id=eq.${fx.orgs.A.catalogIds[0]}`,
        { headers },
      );
      expect(catalog.json, persona).toEqual([{ id: fx.orgs.A.catalogIds[0], price_locked: false }]);
    }
  });

  it("Beto ve el testigo y el candado en SU organización (control positivo) y solo ahí", async () => {
    const fx = fixture();
    const token = await tokenOf("beto");
    const own = await rest(
      token,
      `tenants?select=tenant_id,max_discount_bp&tenant_id=eq.${fx.orgs.B.tenantId}`,
      {
        headers: tenantHeader(fx.orgs.B.tenantId),
      },
    );
    expect(own.json).toEqual([
      { tenant_id: fx.orgs.B.tenantId, max_discount_bp: B_MAX_DISCOUNT_BP },
    ]);
    const locked = await rest(
      token,
      `catalog_items?select=id,price_locked&id=eq.${fx.orgs.B.lockedCatalogId}`,
      {
        headers: tenantHeader(fx.orgs.B.tenantId),
      },
    );
    expect(locked.json).toEqual([{ id: fx.orgs.B.lockedCatalogId, price_locked: true }]);
    const foreign = await rest(token, "catalog_items?select=id,price_locked", {
      headers: tenantHeader(fx.orgs.A.tenantId),
    });
    expect(foreign.json).toEqual([]);
  });
});

describe("Ataque 6 · un servicio de B nombrado desde A", () => {
  /** Guarda en la cotización de A (de Ana) una línea nueva que nombra el servicio `catalogItemId`. */
  async function saveNaming(catalogItemId: string) {
    const fx = fixture();
    const quoteId = fx.orgs.A.quoteIds[0];
    const { rows } = await db.query<{ revision: number }>(
      "select revision from public.quotes where id = $1",
      [quoteId],
    );
    const res = await rpc(
      await tokenOf("ana"),
      "save_quote_draft",
      {
        p_quote_id: quoteId,
        p_expected_revision: rows[0].revision,
        p_save_id: randomUUID(),
        p_header: {
          customer_id: fx.orgs.A.customerIds[0],
          global_discount: { kind: "none", value: 0 },
        },
        p_items: [
          {
            id: randomUUID(),
            catalog_item_id: catalogItemId,
            name: "Línea de ataque",
            description: null,
            unit: "service",
            tax_treatment: "taxable",
            quantity_milli: 1000,
            unit_price_clp: 1,
            discount_kind: "none",
            discount_value: 0,
          },
        ],
        p_expected_totals: {},
      },
      tenantHeader(fx.orgs.A.tenantId),
    );
    return { res, quoteId, revision: rows[0].revision };
  }

  it("bloqueado o no, es el MISMO error (no se averigua el candado ajeno) y la cotización de A no cambia", async () => {
    const fx = fixture();
    const locked = fx.orgs.B.lockedCatalogId!;
    const free = fx.orgs.B.catalogIds.find((id) => id !== locked)!;
    const a = await saveNaming(locked);
    const b = await saveNaming(free);
    expect(a.res.status).toBeGreaterThanOrEqual(400);
    expect(a.res.status).toBe(b.res.status);
    expect(a.res.text).toBe(b.res.text);
    expect(codeOf(a.res)).toBe("CP422");
    for (const text of [a.res.text, b.res.text]) {
      expect(text).not.toContain(fx.orgs.B.canary);
      expect(text).not.toContain(fx.orgs.B.tenantId);
      expect(text).not.toContain(WITNESS);
      expect(text).not.toContain("price_locked");
    }
    const { rows } = await db.query<{ revision: number }>(
      "select revision from public.quotes where id = $1",
      [a.quoteId],
    );
    expect(rows[0].revision).toBe(a.revision);
  });
});

describe("A nivel de base de datos · el tope y el candado salen de la organización que se pregunta", () => {
  const CHECK = "select app.quote_line_rules_check($1, $2, $3) as r";
  const global = JSON.stringify({ kind: "percent", value: 5_000, base_clp: 10_000 });

  it("con el tope de B en 43,21 %, un 50 % general de A no se rechaza (A no tiene tope) y en B sí", async () => {
    const fx = fixture();
    // sin sesión de persona: nadie se salta la regla, y cada organización usa SU tope
    const forA = await db.query(CHECK, [fx.orgs.A.tenantId, "[]", global]);
    expect(forA.rows[0].r.issues).toEqual([]);
    const forB = await db.query(CHECK, [fx.orgs.B.tenantId, "[]", global]);
    expect(forB.rows[0].r.issues).toEqual(["global_discount_over_cap"]);
  });

  it("el candado de un servicio de B no cuenta para A aunque se nombre su id, y sí cuenta para B", async () => {
    const fx = fixture();
    const lockedOfB = fx.orgs.B.lockedCatalogId!;
    const line = JSON.stringify([
      {
        catalog_item_id: lockedOfB,
        catalog_unit_price_clp: 10_000,
        unit_price_clp: 1,
        discount_kind: "none",
        discount_value: 0,
        gross_clp: 1,
      },
    ]);
    const forA = await db.query(CHECK, [fx.orgs.A.tenantId, line, null]);
    expect(forA.rows[0].r.issues).toEqual([]);
    const forB = await db.query(CHECK, [fx.orgs.B.tenantId, line, null]);
    expect(forB.rows[0].r.issues).toEqual(["price_locked@0"]);
  });
});
