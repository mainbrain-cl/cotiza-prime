import { describe, expect, it, vi } from "vitest";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";

// Desde H-010 el nombre de quien se fue también se puede leer (para que sus cotizaciones lo muestren como autor).
// Una solicitud asignada a alguien que ya no está en el equipo tiene que seguir viéndose «sin responsable activo»:
// el Dueño o un Administrador la reasigna. Aquí se comprueba que la lista y la ficha lo siguen diciendo, aunque el
// perfil de esa persona sí sea legible, y que los asignables salen una sola vez aunque la persona esté en dos
// organizaciones (la política de `members` deja ver las propias filas de otras organizaciones).
//
// El cliente falso APLICA los filtros `.eq(...)` y `.in(...)`: si alguien quita el filtro de organización o de
// estado activo de una consulta, estas pruebas fallan.

vi.mock("server-only", () => ({}));

import {
  FORMER_MEMBER_LABEL,
  loadAssignableMembers,
  loadRequest,
  loadRequestList,
} from "./requests-queries";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const FORM = "22222222-2222-4222-8222-222222222222";
const STAYS = "33333333-3333-4333-8333-333333333333";
const LEFT = "44444444-4444-4444-8444-444444444444";
const REQUEST_STAYS = "55555555-5555-4555-8555-555555555555";
const REQUEST_LEFT = "66666666-6666-4666-8666-666666666666";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: null };

const requestRow = (id: string, assignedTo: string): Row => ({
  id,
  form_id: FORM,
  status: "assigned",
  assigned_to: assignedTo,
  created_at: "2026-11-01T12:00:00.000Z",
  contact_name_enc: null,
  items: [],
  anonymized_at: null,
  assigned_at: null,
  assigned_by: null,
  discard_reason: null,
  discard_note: null,
  discarded_at: null,
  quote_id: null,
  converted_at: null,
  contact_email_enc: null,
  contact_phone_enc: null,
  company_enc: null,
  comuna_enc: null,
  service_address_enc: null,
  message_enc: null,
  desired_date: null,
  consent_template_version: "v1",
  consent_text: null,
  consent_text_unavailable: false,
  consented_at: "2026-11-01T12:00:00.000Z",
});

const TABLES: Record<string, Row[]> = {
  intake_requests: [requestRow(REQUEST_STAYS, STAYS), requestRow(REQUEST_LEFT, LEFT)],
  intake_forms: [{ id: FORM, name: "Formulario" }],
  // Ana se queda; Beto se fue; y Ana también es Dueña de OTRA organización (una persona en dos organizaciones).
  members: [
    { user_id: STAYS, tenant_id: TENANT, status: "active", role: "sales" },
    { user_id: LEFT, tenant_id: TENANT, status: "removed", role: "sales" },
    { user_id: STAYS, tenant_id: OTHER_TENANT, status: "active", role: "owner" },
  ],
  profiles: [
    { user_id: STAYS, full_name: "Ana Se Queda" },
    { user_id: LEFT, full_name: "Beto Se Fue" },
  ],
};

function fakeClient() {
  const from = vi.fn((table: string) => {
    const equals: [string, unknown][] = [];
    const isIn: [string, unknown[]][] = [];
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "order", "limit"]) builder[method] = vi.fn(() => builder);
    builder.eq = vi.fn((column: string, value: unknown) => {
      equals.push([column, value]);
      return builder;
    });
    builder.in = vi.fn((column: string, values: unknown[]) => {
      isIn.push([column, values]);
      return builder;
    });
    const rows = (): Row[] =>
      (TABLES[table] ?? []).filter(
        (row) =>
          equals.every(([column, value]) => row[column] === value) &&
          isIn.every(([column, values]) => values.includes(row[column])),
      );
    const resolve = (): Result => ({ data: rows(), error: null });
    builder.maybeSingle = vi.fn(() => Promise.resolve({ data: rows()[0] ?? null, error: null }));
    builder.then = (done: (value: Result) => unknown) => Promise.resolve(resolve()).then(done);
    return builder;
  });
  return { from };
}

const active = () =>
  ({
    tenantId: TENANT,
    tenantName: "Negocio",
    role: "owner",
    userId: STAYS,
    supabase: fakeClient(),
  }) as unknown as ActiveTenant;

describe("el cliente falso aplica los filtros (si no, estas pruebas no probarían nada)", () => {
  it("devuelve solo las filas que cumplen todos los filtros", async () => {
    type Chain = { eq: (column: string, value: unknown) => Chain } & PromiseLike<Result>;
    const members = fakeClient().from("members") as unknown as Chain;
    const result = await members.eq("tenant_id", TENANT).eq("status", "active");
    expect(result.data).toEqual([TABLES.members[0]]);
  });
});

describe("solicitudes asignadas a alguien que ya no está en el equipo", () => {
  it("en la lista dicen «Alguien que ya no está en el equipo», no el nombre de quien se fue", async () => {
    const result = await loadRequestList(active(), "todas");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.rows.map((row) => [row.id, row.assignedToName]));
    expect(byId.get(REQUEST_STAYS)).toBe("Ana Se Queda");
    expect(byId.get(REQUEST_LEFT)).toBe(FORMER_MEMBER_LABEL);
    expect(JSON.stringify(result.rows)).not.toContain("Beto Se Fue");
  });

  it("en la ficha también", async () => {
    const left = await loadRequest(active(), REQUEST_LEFT);
    expect(left.ok).toBe(true);
    if (left.ok) expect(left.detail.assignedToName).toBe(FORMER_MEMBER_LABEL);
    const stays = await loadRequest(active(), REQUEST_STAYS);
    expect(stays.ok).toBe(true);
    if (stays.ok) expect(stays.detail.assignedToName).toBe("Ana Se Queda");
  });

  it("alguien que está activo en OTRA organización, pero se fue de esta, tampoco cuenta como responsable activo", async () => {
    // Beto se fue de esta organización pero sigue activo en otra: si la consulta no filtrara por organización,
    // se leería su nombre. (Aquí se agrega su fila de la otra organización solo para esta prueba.)
    TABLES.members.push({
      user_id: LEFT,
      tenant_id: OTHER_TENANT,
      status: "active",
      role: "sales",
    });
    try {
      const result = await loadRequestList(active(), "todas");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rows.find((row) => row.id === REQUEST_LEFT)?.assignedToName).toBe(
        FORMER_MEMBER_LABEL,
      );
    } finally {
      TABLES.members.pop();
    }
  });
});

describe("a quién se puede asignar", () => {
  it("una persona que está en dos organizaciones sale una sola vez, y no sale quien se fue", async () => {
    const list = await loadAssignableMembers(active());
    expect(list).toEqual([{ userId: STAYS, name: "Ana Se Queda", role: "sales" }]);
  });
});
