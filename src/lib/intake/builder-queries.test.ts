import { describe, expect, it, vi } from "vitest";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";

vi.mock("@/lib/http/request-context", () => ({ getAppOrigin: () => "http://localhost:3000" }));

import {
  REQUEST_COUNT_READ_LIMIT,
  itemsToKeepInactive,
  loadForm,
  loadFormList,
} from "./builder-queries";

type Result = { data?: unknown; error?: { code: string; message: string } | null };

/**
 * Cliente de Supabase de mentira: cada tabla responde con lo que se le guion, sin importar los
 * filtros. Guarda las consultas para comprobar cuántas se hicieron y a qué tablas.
 */
function fakeActive(script: Record<string, Result | Result[]>, role = "owner") {
  const calls: { table: string; filters: unknown[][] }[] = [];
  const rpcs: { name: string; args: unknown }[] = [];
  const queues = new Map<string, Result[]>();
  for (const [table, value] of Object.entries(script)) {
    queues.set(table, Array.isArray(value) ? [...value] : [value]);
  }
  const supabase = {
    // `intake_form_daily_caps`: el tope diario ya no se lee de la tabla (columna privada).
    rpc(name: string, args: unknown) {
      rpcs.push({ name, args });
      const result: Result = { error: null, ...(script[name] as Result) };
      return { then: (resolve: (value: Result) => unknown) => resolve(result) };
    },
    from(table: string) {
      const call = { table, filters: [] as unknown[][] };
      calls.push(call);
      const queue = queues.get(table) ?? [{ data: [], error: null }];
      const next = (): Result => (queue.length > 1 ? queue.shift()! : queue[0]);
      const builder: Record<string, unknown> = {};
      for (const method of [
        "select",
        "eq",
        "neq",
        "in",
        "order",
        "limit",
        "contains",
        "maybeSingle",
      ]) {
        builder[method] = (...args: unknown[]) => {
          call.filters.push([method, ...args]);
          return builder;
        };
      }
      builder.then = (resolve: (value: Result) => unknown) => resolve({ error: null, ...next() });
      return builder;
    },
  };
  return { active: { role, supabase } as unknown as ActiveTenant, calls, rpcs };
}

const FORM_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  public_id: "abcdefghijklmnopqrstuv",
  status: "draft",
  revision: 3,
  name: "Fletes",
  title: "Pide tu cotización",
  intro: "",
  success_message: "",
  fields: {},
  privacy_policy_url: null,
};
// Lo que devuelve `intake_form_daily_caps` para este formulario.
const CAP_ROW = { form_id: FORM_ROW.id, daily_cap: 50 };

describe("loadForm", () => {
  it("si falla la lectura del formulario devuelve error, no «no encontrado»", async () => {
    const { active } = fakeActive({
      intake_forms: { data: null, error: { code: "57014", message: "timeout" } },
    });
    expect(await loadForm(active, FORM_ROW.id)).toEqual({ ok: false, reason: "error" });
  });

  it("si falla la lectura de los servicios devuelve error, nunca un editor con la lista vacía", async () => {
    const { active } = fakeActive({
      intake_forms: { data: FORM_ROW },
      intake_form_daily_caps: { data: [CAP_ROW] },
      intake_form_items: { data: null, error: { code: "57014", message: "timeout" } },
    });
    const result = await loadForm(active, FORM_ROW.id);
    expect(result).toEqual({ ok: false, reason: "error" });
  });

  it("un formulario que no existe en esta organización es «no encontrado»", async () => {
    const { active } = fakeActive({ intake_forms: { data: null } });
    expect(await loadForm(active, FORM_ROW.id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("con todo bien devuelve el formulario con sus servicios", async () => {
    const { active, calls, rpcs } = fakeActive({
      intake_forms: { data: FORM_ROW },
      intake_form_daily_caps: { data: [CAP_ROW] },
      intake_form_items: {
        data: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            kind: "free",
            catalog_item_id: null,
            public_name: "Flete",
            public_description: null,
            unit: "service",
            quantity_mode: "optional",
            min_qty_milli: null,
            max_qty_milli: null,
          },
        ],
      },
    });
    const result = await loadForm(active, FORM_ROW.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loaded.revision).toBe(3);
      expect(result.loaded.dailyCap).toBe(50);
      expect(result.loaded.form.items).toHaveLength(1);
      expect(result.loaded.publicUrl).toBeNull();
    }
    // La tabla no se consulta por `daily_cap` (columna privada): el tope viene de la función.
    const formQuery = calls.find((c) => c.table === "intake_forms")!;
    expect(JSON.stringify(formQuery.filters)).not.toContain("daily_cap");
    expect(rpcs).toEqual([{ name: "intake_form_daily_caps", args: { p_form_id: FORM_ROW.id } }]);
  });

  it("Aprobador, Comercial y Observador cargan el formulario sin pedir el tope (queda en null, no en 0)", async () => {
    for (const role of ["approver", "sales", "viewer"]) {
      const { active, rpcs } = fakeActive(
        { intake_forms: { data: FORM_ROW }, intake_form_items: { data: [] } },
        role,
      );
      const result = await loadForm(active, FORM_ROW.id);
      expect(result.ok, role).toBe(true);
      if (result.ok) expect(result.loaded.dailyCap, role).toBeNull();
      expect(rpcs, role).toEqual([]);
    }
  });

  it("si falla la lectura del tope (o no vuelve fila) para quien la pide, devuelve error, nunca un tope inventado", async () => {
    const failed = fakeActive({
      intake_forms: { data: FORM_ROW },
      intake_form_items: { data: [] },
      intake_form_daily_caps: { data: null, error: { code: "57014", message: "timeout" } },
    });
    expect(await loadForm(failed.active, FORM_ROW.id)).toEqual({ ok: false, reason: "error" });
    const empty = fakeActive({
      intake_forms: { data: FORM_ROW },
      intake_form_items: { data: [] },
      intake_form_daily_caps: { data: [] },
    });
    expect(await loadForm(empty.active, FORM_ROW.id)).toEqual({ ok: false, reason: "error" });
  });
});

describe("loadFormList", () => {
  const forms = [
    { id: "a", name: "Uno", status: "published", public_id: "ppppppppppppppppppppp1" },
    { id: "b", name: "Dos", status: "draft", public_id: "ppppppppppppppppppppp2" },
  ];

  it("cuenta las solicitudes con UNA sola consulta agrupada por formulario", async () => {
    const { active, calls } = fakeActive({
      intake_forms: { data: forms },
      intake_requests: { data: [{ form_id: "a" }, { form_id: "a" }, { form_id: "b" }] },
    });
    const result = await loadFormList(active, false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls.filter((c) => c.table === "intake_requests")).toHaveLength(1);
    expect(result.rows.map((r) => r.requestCount)).toEqual([2, 1]);
    expect(result.rows[0].publicUrl).toContain("/f/");
    expect(result.rows[1].publicUrl).toBeNull();
  });

  it("si el conteo falla no dice «Sin solicitudes»: deja el número vacío para avisar", async () => {
    const { active } = fakeActive({
      intake_forms: { data: forms },
      intake_requests: { data: null, error: { code: "42501", message: "denied" } },
    });
    const result = await loadFormList(active, false);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows.map((r) => r.requestCount)).toEqual([null, null]);
  });

  it("un formulario sin solicitudes cuenta 0 cuando la consulta salió bien", async () => {
    const { active } = fakeActive({
      intake_forms: { data: forms },
      intake_requests: { data: [{ form_id: "a" }] },
    });
    const result = await loadFormList(active, false);
    if (result.ok) expect(result.rows.map((r) => r.requestCount)).toEqual([1, 0]);
  });

  it("si la lectura llega al tope, el conteo se marca como «al menos»", async () => {
    const full = Array.from({ length: REQUEST_COUNT_READ_LIMIT }, () => ({ form_id: "a" }));
    const { active } = fakeActive({
      intake_forms: { data: forms },
      intake_requests: { data: full },
    });
    const result = await loadFormList(active, false);
    if (result.ok) expect(result.rows.every((r) => r.requestCountIsLowerBound)).toBe(true);
  });

  it("sin formularios no consulta solicitudes", async () => {
    const { active, calls } = fakeActive({ intake_forms: { data: [] } });
    const result = await loadFormList(active, false);
    expect(result.ok && result.rows).toEqual([]);
    expect(calls.some((c) => c.table === "intake_requests")).toBe(false);
  });

  it("si falla la lista de formularios devuelve error", async () => {
    const { active } = fakeActive({
      intake_forms: { data: null, error: { code: "XX000", message: "boom" } },
    });
    expect(await loadFormList(active, false)).toEqual({ ok: false });
  });
});

describe("itemsToKeepInactive", () => {
  const FORM = "11111111-1111-4111-8111-111111111111";
  const row = (id: string) => ({
    id,
    kind: "catalog",
    catalog_item_id: "99999999-9999-4999-8999-999999999999",
    public_name: "Flete",
    public_description: "Santiago",
    unit: "service",
    quantity_mode: "optional",
    min_qty_milli: null,
    max_qty_milli: "2000",
  });

  it("un servicio quitado que ya tuvo solicitudes queda inactivo, con sus datos", async () => {
    const { active } = fakeActive({
      intake_form_items: { data: [row("i1"), row("i2")] },
      intake_requests: { data: [{ id: "r1" }] },
    });
    const kept = await itemsToKeepInactive(active, FORM, ["i2"]);
    expect(kept).toHaveLength(1);
    expect(kept![0]).toMatchObject({ id: "i1", is_active: false, max_qty_milli: 2000 });
  });

  it("uno quitado sin solicitudes se deja ir (se borra)", async () => {
    const { active } = fakeActive({
      intake_form_items: { data: [row("i1")] },
      intake_requests: { data: [] },
    });
    expect(await itemsToKeepInactive(active, FORM, [])).toEqual([]);
  });

  it("si nada se quitó no consulta solicitudes", async () => {
    const { active, calls } = fakeActive({ intake_form_items: { data: [row("i1")] } });
    expect(await itemsToKeepInactive(active, FORM, ["i1"])).toEqual([]);
    expect(calls.some((c) => c.table === "intake_requests")).toBe(false);
  });

  it("si no se puede leer, devuelve null: es mejor un error que borrar historia", async () => {
    const { active } = fakeActive({
      intake_form_items: { data: [row("i1")] },
      intake_requests: { data: null, error: { code: "XX000", message: "boom" } },
    });
    expect(await itemsToKeepInactive(active, FORM, [])).toBeNull();
  });
});
