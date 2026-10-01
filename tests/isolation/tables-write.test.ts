// H-012 · Escritura. Con pases reales, intentar crear, editar, mover o borrar filas de otra
// organización (ataques A06–A09, A11, X5). La prueba que manda no es la respuesta HTTP sino la
// verificación posterior con `pg`: las filas de B quedan IDÉNTICAS (huella antes y después) y no
// existe ninguna fila marcada como de ataque.
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rest } from "../support/local-supabase";
import {
  aRowOfB,
  countWhere,
  fingerprint,
  fixture,
  isRejectedOrEmpty,
  openDb,
  tenantHeader,
  tokenOf,
} from "./context";
import { ISOLATION_TABLES, type TableSpec } from "./registry";

let db: Client;
let marker: string;
const before = new Map<string, string>();

beforeAll(async () => {
  db = await openDb();
  marker = `ATAQUE-${fixture().runId}`;
  for (const spec of ISOLATION_TABLES) before.set(spec.name, await fingerprint(db, spec));
});
afterAll(async () => {
  await db.end();
});

const headersFor = () => {
  const fx = fixture();
  return [
    ["con la cabecera de A", fx.orgs.A.tenantId],
    ["con la cabecera de B", fx.orgs.B.tenantId],
    ["sin cabecera", undefined],
  ] as const;
};

/** Tablas donde un intento "legítimo" de Ana con su cabecera A puede crear una fila propia: hay que apuntar a B. */
describe.each(ISOLATION_TABLES)("escritura sobre $name", (spec: TableSpec) => {
  it("A06 · crear una fila con tenant_id de B es rechazado (con A, con B o sin cabecera)", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    for (const [label, header] of headersFor()) {
      const res = await rest(token, spec.name, {
        method: "POST",
        headers: { Prefer: "return=representation", ...tenantHeader(header) },
        body: spec.insertAttack(fx, fx.orgs.B.tenantId, `${marker}-${label}`),
      });
      expect(
        isRejectedOrEmpty(res),
        `${spec.name} ${label}: ${res.status} ${res.text.slice(0, 160)}`,
      ).toBe(true);
    }
  });

  it("A07 · editar por identificador una fila de B no cambia nada", async () => {
    const fx = fixture();
    const id = await aRowOfB(db, spec);
    expect(id).not.toBeNull();
    const token = await tokenOf("ana");
    for (const [label, header] of headersFor()) {
      const res = await rest(token, `${spec.name}?${spec.idColumn}=eq.${id}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation", ...tenantHeader(header) },
        body: spec.updateAttack(`${marker}-${label}`),
      });
      expect(isRejectedOrEmpty(res), `${spec.name} ${label}: ${res.status}`).toBe(true);
    }
    // edición masiva sin filtro: tampoco puede alcanzar a B
    const bulk = await rest(token, `${spec.name}?tenant_id=eq.${fx.orgs.B.tenantId}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation", ...tenantHeader(fx.orgs.A.tenantId) },
      body: spec.updateAttack(`${marker}-masivo`),
    });
    expect(isRejectedOrEmpty(bulk)).toBe(true);
  });

  it("control positivo · el mismo cuerpo apuntado a la propia organización sí se acepta (A06 y A07)", async () => {
    if (!spec.ownWriteAccepted) return; // se escribe solo por funciones o por el servidor
    const fx = fixture();
    const token = await tokenOf("ana");
    const headers = { Prefer: "return=representation", ...tenantHeader(fx.orgs.A.tenantId) };
    // A06 con la organización propia: el cuerpo es válido, así que el rechazo de arriba era por aislamiento
    const created = await rest(token, spec.name, {
      method: "POST",
      headers,
      body: spec.insertAttack(fx, fx.orgs.A.tenantId, `LEGITIMO-${fx.runId}`),
    });
    expect(created.status, `${spec.name}: ${created.text.slice(0, 160)}`).toBe(201);
    const row = (created.json as Record<string, string>[])[0];
    expect(row.tenant_id).toBe(fx.orgs.A.tenantId);
    // A07 con la fila propia: el mismo cambio sí se aplica
    const updated = await rest(token, `${spec.name}?${spec.idColumn}=eq.${row[spec.idColumn]}`, {
      method: "PATCH",
      headers,
      body: spec.updateAttack(`LEGITIMO-editado-${fx.runId}`),
    });
    expect(updated.status, `${spec.name}: ${updated.text.slice(0, 160)}`).toBe(200);
    expect((updated.json as unknown[]).length).toBe(1);
  });

  it("A09 · borrar una fila de B (o propia) es rechazado y no desaparece nada", async () => {
    const fx = fixture();
    const id = await aRowOfB(db, spec);
    const token = await tokenOf("ana");
    for (const [label, header] of headersFor()) {
      const res = await rest(token, `${spec.name}?${spec.idColumn}=eq.${id}`, {
        method: "DELETE",
        headers: { Prefer: "return=representation", ...tenantHeader(header) },
      });
      expect(isRejectedOrEmpty(res), `${spec.name} ${label}: ${res.status}`).toBe(true);
    }
    // borrado masivo con la cabecera de A
    const bulk = await rest(token, `${spec.name}?tenant_id=eq.${fx.orgs.A.tenantId}`, {
      method: "DELETE",
      headers: { Prefer: "return=representation", ...tenantHeader(fx.orgs.A.tenantId) },
    });
    expect(bulk.status >= 400 || (Array.isArray(bulk.json) && bulk.json.length === 0)).toBe(true);
  });

  it("al final, las filas de B de esta tabla están idénticas", async () => {
    expect(await fingerprint(db, spec)).toBe(before.get(spec.name));
  });
});

describe("A08 · una fila propia no se puede mudar a otra organización", () => {
  it("cambiar tenant_id de un cliente, de un servicio o de la propia organización es rechazado", async () => {
    const fx = fixture();
    const token = await tokenOf("ana");
    const targets: [string, string, string][] = [
      ["customers", "id", fx.orgs.A.customerIds[0]],
      ["catalog_items", "id", fx.orgs.A.catalogIds[0]],
      ["tenants", "tenant_id", fx.orgs.A.tenantId],
      ["numbering_settings", "tenant_id", fx.orgs.A.tenantId],
    ];
    for (const [table, idColumn, id] of targets) {
      for (const [label, header] of headersFor()) {
        const res = await rest(token, `${table}?${idColumn}=eq.${id}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation", ...tenantHeader(header) },
          body: { tenant_id: fx.orgs.B.tenantId },
        });
        expect(isRejectedOrEmpty(res), `${table} ${label}: ${res.status}`).toBe(true);
      }
      expect(
        await countWhere(
          db,
          table,
          `${idColumn} = '${id}' and tenant_id = '${fx.orgs.A.tenantId}'`,
        ),
        table,
      ).toBe(1);
      expect(
        await countWhere(
          db,
          table,
          `${idColumn} = '${id}' and tenant_id = '${fx.orgs.B.tenantId}'`,
        ),
        table,
      ).toBe(0);
    }
  });

  it("y tampoco se puede cambiar tenant_id junto con otros campos permitidos", async () => {
    const fx = fixture();
    const res = await rest(await tokenOf("ana"), `customers?id=eq.${fx.orgs.A.customerIds[1]}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation", ...tenantHeader(fx.orgs.A.tenantId) },
      body: { display_name: `${marker}-mudanza`, tenant_id: fx.orgs.B.tenantId },
    });
    expect(isRejectedOrEmpty(res)).toBe(true);
    expect(await countWhere(db, "customers", `display_name like '${marker}%'`)).toBe(0);
  });
});

describe("A11 · quien está en dos organizaciones no puede escribir en una mientras trabaja en la otra", () => {
  it("Mixta con A y tenant_id de B (y al revés): rechazado, nada queda en la organización equivocada", async () => {
    const fx = fixture();
    const token = await tokenOf("mixta");
    const customer = (tenant: string, label: string) => ({
      id: crypto.randomUUID(),
      tenant_id: tenant,
      kind: "person",
      display_name: `${marker}-mixta-${label}`,
    });
    const crossA = await rest(token, "customers", {
      method: "POST",
      headers: { Prefer: "return=representation", ...tenantHeader(fx.orgs.A.tenantId) },
      body: customer(fx.orgs.B.tenantId, "A-con-B"),
    });
    const crossB = await rest(token, "customers", {
      method: "POST",
      headers: { Prefer: "return=representation", ...tenantHeader(fx.orgs.B.tenantId) },
      body: customer(fx.orgs.A.tenantId, "B-con-A"),
    });
    const crossItem = await rest(token, "catalog_items", {
      method: "POST",
      headers: { Prefer: "return=representation", ...tenantHeader(fx.orgs.A.tenantId) },
      body: {
        tenant_id: fx.orgs.B.tenantId,
        name: `${marker}-mixta-item`,
        unit: "service",
        unit_price_clp: 1,
      },
    });
    for (const res of [crossA, crossB, crossItem])
      expect(isRejectedOrEmpty(res), res.text.slice(0, 160)).toBe(true);
    expect(await countWhere(db, "customers", `display_name like '${marker}-mixta%'`)).toBe(0);
    expect(await countWhere(db, "catalog_items", `name like '${marker}-mixta%'`)).toBe(0);
  });

  it("Mixta sí puede crear en la organización que tiene activa (control positivo), y queda en esa", async () => {
    const fx = fixture();
    const token = await tokenOf("mixta");
    const id = crypto.randomUUID();
    const res = await rest(token, "customers", {
      method: "POST",
      headers: { Prefer: "return=representation", ...tenantHeader(fx.orgs.A.tenantId) },
      body: {
        id,
        tenant_id: fx.orgs.A.tenantId,
        kind: "person",
        display_name: `LEGITIMO-${fx.runId}`,
      },
    });
    expect(res.status, res.text).toBe(201);
    expect(
      await countWhere(db, "customers", `id = '${id}' and tenant_id = '${fx.orgs.A.tenantId}'`),
    ).toBe(1);
    // sin tenant_id en el cuerpo, toma el de la cabecera activa (B), no el de A
    const id2 = crypto.randomUUID();
    const res2 = await rest(token, "customers", {
      method: "POST",
      headers: { Prefer: "return=representation", ...tenantHeader(fx.orgs.B.tenantId) },
      body: { id: id2, kind: "person", display_name: `LEGITIMO-B-${fx.runId}` },
    });
    expect(res2.status, res2.text).toBe(201);
    expect(
      await countWhere(db, "customers", `id = '${id2}' and tenant_id = '${fx.orgs.B.tenantId}'`),
    ).toBe(1);
  });
});

describe("X5 · el upsert no sirve para pisar filas de otra organización", () => {
  it("merge-duplicates con el identificador de un cliente de B es rechazado y B queda intacta", async () => {
    const fx = fixture();
    const customersSpec = ISOLATION_TABLES.find((t) => t.name === "customers")!;
    const bFingerprint = await fingerprint(db, customersSpec);
    const targetId = fx.orgs.B.customerIds[0];
    const token = await tokenOf("ana");
    for (const tenant of [fx.orgs.A.tenantId, fx.orgs.B.tenantId]) {
      for (const [label, header] of headersFor()) {
        for (const resolution of ["merge-duplicates", "ignore-duplicates"]) {
          const res = await rest(token, "customers?on_conflict=id", {
            method: "POST",
            headers: {
              Prefer: `resolution=${resolution},return=representation`,
              ...tenantHeader(header),
            },
            body: {
              id: targetId,
              tenant_id: tenant,
              kind: "person",
              display_name: `${marker}-upsert-${label}`,
            },
          });
          // rechazado, o ignorado sin devolver la fila de B
          expect(res.text, `${label} ${resolution}`).not.toContain(fx.orgs.B.canary);
          if (res.status < 400) expect(res.json).toEqual([]);
        }
      }
    }
    expect(await fingerprint(db, customersSpec)).toBe(bFingerprint);
    expect(await countWhere(db, "customers", `display_name like '${marker}-upsert%'`)).toBe(0);
  });
});

describe("ninguna fila de ataque llegó a existir, en ninguna organización", () => {
  it("customers, catalog_items y tenants no tienen filas marcadas como de ataque", async () => {
    expect(await countWhere(db, "customers", `display_name like '${marker}%'`)).toBe(0);
    expect(await countWhere(db, "catalog_items", `name like '${marker}%'`)).toBe(0);
    expect(await countWhere(db, "tenants", `name like '${marker}%'`)).toBe(0);
    expect(await countWhere(db, "profiles", `full_name like '${marker}%'`)).toBe(0);
    expect(await countWhere(db, "numbering_settings", `prefix = 'ATAQUE'`)).toBe(0);
    expect(await countWhere(db, "audit_log", `action = 'ataque.registro'`)).toBe(0);
  });
});
