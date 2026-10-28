import { describe, expect, it, vi } from "vitest";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import {
  canSeeProtection,
  capStateOfForm,
  loadProtection,
  organizationCapState,
  summaryOfForm,
  summaryOfOrganization,
} from "./protection-queries";

const FORM_A = "11111111-1111-4111-8111-111111111111";
const FORM_B = "22222222-2222-4222-8222-222222222222";

type Result = { data?: unknown; error?: { code: string } | null };

function fakeActive(role: string, script: Record<string, Result>) {
  const tables: string[] = [];
  const supabase = {
    from(table: string) {
      tables.push(table);
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "gte", "order", "limit"]) {
        builder[method] = () => builder;
      }
      builder.then = (resolve: (value: Result) => unknown) =>
        resolve({ error: null, ...(script[table] ?? { data: [] }) });
      return builder;
    },
  };
  return { active: { role, tenantId: "t", supabase } as unknown as ActiveTenant, tables };
}

const counters = (rows: Record<string, unknown>[]) => ({
  data: rows.map((row) => ({
    accepted: 0,
    blocked_captcha: 0,
    blocked_rate: 0,
    blocked_cap: 0,
    blocked_invalid: 0,
    ...row,
  })),
});

describe("loadProtection (H-092)", () => {
  it("solo Dueño y Administrador; los demás roles ni consultan la base", async () => {
    for (const role of ["approver", "sales", "viewer"]) {
      const { active, tables } = fakeActive(role, {});
      expect(await loadProtection(active)).toEqual({ ok: false, reason: "forbidden" });
      expect(tables, role).toEqual([]);
      expect(canSeeProtection(role)).toBe(false);
    }
    expect(canSeeProtection("owner")).toBe(true);
    expect(canSeeProtection("admin")).toBe(true);
  });

  it("un error de lectura (de los contadores o de los formularios) da «error», nunca ceros", async () => {
    const a = fakeActive("owner", { intake_daily_counters: { data: null, error: { code: "X" } } });
    expect(await loadProtection(a.active)).toEqual({ ok: false, reason: "error" });
    const b = fakeActive("owner", {
      intake_daily_counters: counters([]),
      intake_forms: { data: null, error: { code: "X" } },
    });
    expect(await loadProtection(b.active)).toEqual({ ok: false, reason: "error" });
  });

  it("lee solo las dos tablas necesarias y arma los contadores por formulario y de la organización", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T15:00:00Z"));
    try {
      const { active, tables } = fakeActive("admin", {
        intake_daily_counters: counters([
          { form_id: FORM_A, day: "2026-10-07", accepted: 2, blocked_cap: 3 },
          { form_id: FORM_B, day: "2026-10-07", accepted: 1, blocked_captcha: 4 },
        ]),
        intake_forms: {
          data: [
            { id: FORM_A, daily_cap: 2 },
            { id: FORM_B, daily_cap: 50 },
          ],
        },
      });
      const data = await loadProtection(active);
      expect(tables.sort()).toEqual(["intake_daily_counters", "intake_forms"]);
      expect(data.ok).toBe(true);
      if (!data.ok) return;
      expect(summaryOfForm(data, FORM_A).today).toMatchObject({ accepted: 2, blockedCap: 3 });
      expect(summaryOfForm(data, FORM_B).today).toMatchObject({ accepted: 1, blockedCaptcha: 4 });
      expect(summaryOfOrganization(data).today.accepted).toBe(3);
      expect(capStateOfForm(data, FORM_A)).toMatchObject({
        reached: true,
        kind: "form",
        accepted: 2,
      });
      expect(capStateOfForm(data, FORM_B)).toEqual({ reached: false });
      expect(capStateOfForm(data, "33333333-3333-4333-8333-333333333333")).toEqual({
        reached: false,
      });
      expect(organizationCapState(data)).toEqual({ reached: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("el tope de la organización (300) se detecta sumando todos los formularios", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T15:00:00Z"));
    try {
      const { active } = fakeActive("owner", {
        intake_daily_counters: counters([
          { form_id: FORM_A, day: "2026-10-07", accepted: 200 },
          { form_id: FORM_B, day: "2026-10-07", accepted: 100 },
        ]),
        intake_forms: {
          data: [
            { id: FORM_A, daily_cap: 200 },
            { id: FORM_B, daily_cap: 200 },
          ],
        },
      });
      const data = await loadProtection(active);
      if (!data.ok) throw new Error("debía leer");
      expect(organizationCapState(data)).toMatchObject({ reached: true, kind: "org", cap: 300 });
      expect(capStateOfForm(data, FORM_B)).toMatchObject({ reached: true, kind: "org" });
    } finally {
      vi.useRealTimers();
    }
  });
});
