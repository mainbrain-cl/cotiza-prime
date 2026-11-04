import { describe, expect, it, vi } from "vitest";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { loadSnippet, loadSnippets } from "./queries";

vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn() }));

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const SNIPPET_ID = "22222222-2222-4222-8222-222222222222";

const stored = (over: Record<string, unknown>) => ({
  id: SNIPPET_ID,
  kind: "conditions",
  name: "Pago",
  body: "Pago a 30 días.",
  is_default: false,
  revision: 3,
  updated_at: "2026-11-04T12:00:00.000Z",
  ...over,
});

/** Cliente falso: anota las llamadas y entrega el resultado indicado. */
function fakeActive(result: { data: unknown; error: { code?: string } | null }) {
  const calls: [string, ...unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) {
    builder[method] = vi.fn((...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    });
  }
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const from = vi.fn((table: string) => {
    calls.push(["from", table]);
    return builder;
  });
  const active = { tenantId: TENANT_ID, supabase: { from } } as unknown as ActiveTenant;
  return { active, calls };
}

describe("loadSnippets", () => {
  it("lee solo la tabla de textos de la organización activa y los entrega agrupados y ordenados", async () => {
    const { active, calls } = fakeActive({
      data: [
        stored({ id: "a", kind: "footer_note", name: "Vigencia" }),
        stored({ id: "b", kind: "email_body", name: "Seguimiento", is_default: false }),
        stored({ id: "c", kind: "email_body", name: "Saludo", is_default: true }),
        stored({ id: "d", kind: "conditions", name: "Contado" }),
      ],
      error: null,
    });
    const list = await loadSnippets(active);
    expect(calls).toContainEqual(["from", "text_snippets"]);
    expect(calls).toContainEqual(["eq", "tenant_id", TENANT_ID]);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.total).toBe(4);
    expect(list.groups.map((g) => g.kind)).toEqual(["email_body", "conditions", "footer_note"]);
    expect(list.groups[0].rows.map((r) => [r.name, r.isDefault])).toEqual([
      ["Saludo", true],
      ["Seguimiento", false],
    ]);
  });

  it("un tipo desconocido no se muestra", async () => {
    const { active } = fakeActive({ data: [stored({ kind: "raro" })], error: null });
    const list = await loadSnippets(active);
    expect(list).toEqual({ ok: true, groups: [], total: 0 });
  });

  it("si la lectura falla, avisa sin entregar nada", async () => {
    const { active } = fakeActive({ data: null, error: { code: "XX000" } });
    expect(await loadSnippets(active)).toEqual({ ok: false });
  });
});

describe("loadSnippet", () => {
  it("devuelve el texto con su revisión", async () => {
    const { active, calls } = fakeActive({ data: stored({}), error: null });
    const found = await loadSnippet(active, SNIPPET_ID);
    expect(calls).toContainEqual(["eq", "tenant_id", TENANT_ID]);
    expect(calls).toContainEqual(["eq", "id", SNIPPET_ID]);
    expect(found).toMatchObject({
      status: "found",
      row: { id: SNIPPET_ID, kind: "conditions", name: "Pago", revision: 3 },
    });
  });

  it("uno que no está (o es de otra organización) y un identificador roto dan lo mismo: «missing», sin consultar el roto", async () => {
    const empty = fakeActive({ data: null, error: null });
    expect(await loadSnippet(empty.active, SNIPPET_ID)).toEqual({ status: "missing" });
    const broken = fakeActive({ data: stored({}), error: null });
    expect(await loadSnippet(broken.active, "no-es-un-uuid")).toEqual({ status: "missing" });
    expect(broken.calls).toEqual([]);
  });

  it("si la lectura falla, es un error y no «no encontrado»", async () => {
    const { active } = fakeActive({ data: null, error: { code: "XX000" } });
    expect(await loadSnippet(active, SNIPPET_ID)).toEqual({ status: "error" });
  });
});
