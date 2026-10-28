import { beforeEach, describe, expect, it, vi } from "vitest";

const requireActiveTenant = vi.fn();
vi.mock("@/lib/tenant/active-tenant", () => ({
  requireActiveTenant: (...args: unknown[]) => requireActiveTenant(...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/http/request-context", () => ({ getAppOrigin: () => "http://localhost:3000" }));
vi.mock("@/lib/log/server-log", () => ({ serverLog: vi.fn(async () => undefined) }));

import { saveDailyCapAction, saveEmbedOriginsAction } from "./builder-actions";

const TENANT = "11111111-1111-4111-8111-111111111111";
const FORM = "22222222-2222-4222-8222-222222222222";

const rpc = vi.fn();
const FOUND = { data: { revision: 4 }, error: null };
function active(role: string, read: { data: unknown; error: unknown } = FOUND) {
  return {
    tenantId: TENANT,
    role,
    supabase: {
      rpc,
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => read }),
        }),
      }),
    },
  };
}

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: { revision: 4 }, error: null });
  requireActiveTenant.mockReset();
});

describe("saveEmbedOriginsAction (H-093)", () => {
  it("el servidor rechaza sitios peligrosos SIN llamar a la base", async () => {
    requireActiveTenant.mockResolvedValue(active("owner"));
    const bad = [
      "http://sitio.cl",
      "*",
      "https://*.sitio.cl",
      "https://sitio.cl; script-src *",
      "https://sitio.cl/ruta",
      "https://SITIO.cl",
      "https://sitio.cl\nx",
      "",
    ];
    for (const origin of bad) {
      const result = await saveEmbedOriginsAction(TENANT, FORM, [origin]);
      expect(result.status, origin).toBe("error");
    }
    const tooMany = await saveEmbedOriginsAction(
      TENANT,
      FORM,
      Array.from({ length: 11 }, (_, i) => `https://s${i}.cl`),
    );
    expect(tooMany.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("un valor que no es texto se rechaza", async () => {
    requireActiveTenant.mockResolvedValue(active("owner"));
    const result = await saveEmbedOriginsAction(TENANT, FORM, [42 as unknown as string]);
    expect(result.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("solo Dueño y Administrador: el Comercial, el Aprobador y el Observador no llegan a la base", async () => {
    for (const role of ["sales", "approver", "viewer"]) {
      requireActiveTenant.mockResolvedValue(active(role));
      const result = await saveEmbedOriginsAction(TENANT, FORM, ["https://sitio.cl"]);
      expect(result).toMatchObject({ status: "error", kind: "forbidden" });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("un identificador de formulario mal formado no llega a la base", async () => {
    requireActiveTenant.mockResolvedValue(active("owner"));
    const result = await saveEmbedOriginsAction(TENANT, "no-es-un-uuid", ["https://sitio.cl"]);
    expect(result).toMatchObject({ status: "error", kind: "not_found" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("guarda solo la clave embed_origins, sin servicios, sin repetidos y ordenados", async () => {
    requireActiveTenant.mockResolvedValue(active("admin"));
    const result = await saveEmbedOriginsAction(TENANT, FORM, [
      "https://b.cl",
      "https://a.cl",
      "https://b.cl",
    ]);
    expect(result).toMatchObject({ status: "ok", embedOrigins: ["https://a.cl", "https://b.cl"] });
    expect(rpc).toHaveBeenCalledWith("save_intake_form", {
      p_form_id: FORM,
      p_expected_revision: 4,
      p_form: { embed_origins: ["https://a.cl", "https://b.cl"] },
      p_items: null,
    });
  });

  it("un error de la base se traduce sin detalle técnico", async () => {
    requireActiveTenant.mockResolvedValue(active("owner"));
    rpc.mockResolvedValue({
      data: null,
      error: { code: "CP422", message: "invalid_embed_origins" },
    });
    const result = await saveEmbedOriginsAction(TENANT, FORM, ["https://a.cl"]);
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("invalid_embed_origins");
  });
});

describe("saveDailyCapAction (H-092)", () => {
  it("rechaza topes fuera de 1 a 200 o no enteros SIN llamar a la base", async () => {
    requireActiveTenant.mockResolvedValue(active("owner"));
    for (const value of [0, 201, -3, 1.5, Number.NaN, "50" as unknown as number]) {
      const result = await saveDailyCapAction(TENANT, FORM, value);
      expect(result, String(value)).toMatchObject({ status: "error", kind: "invalid" });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("solo Dueño y Administrador: los demás roles no llegan a la base", async () => {
    for (const role of ["sales", "approver", "viewer"]) {
      requireActiveTenant.mockResolvedValue(active(role));
      expect(await saveDailyCapAction(TENANT, FORM, 10)).toMatchObject({
        status: "error",
        kind: "forbidden",
      });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("un identificador mal formado no llega a la base", async () => {
    requireActiveTenant.mockResolvedValue(active("owner"));
    expect(await saveDailyCapAction(TENANT, "x", 10)).toMatchObject({ kind: "not_found" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("guarda solo la clave daily_cap, sin servicios", async () => {
    requireActiveTenant.mockResolvedValue(active("admin"));
    const result = await saveDailyCapAction(TENANT, FORM, 120);
    expect(result).toMatchObject({ status: "ok", dailyCap: 120 });
    expect(rpc).toHaveBeenCalledWith("save_intake_form", {
      p_form_id: FORM,
      p_expected_revision: 4,
      p_form: { daily_cap: 120 },
      p_items: null,
    });
  });

  it("un rechazo de la base se explica sin detalle técnico, y el permiso (42501) como permiso", async () => {
    requireActiveTenant.mockResolvedValue(active("owner"));
    rpc.mockResolvedValue({ data: null, error: { code: "CP422", message: "invalid_daily_cap" } });
    const invalid = await saveDailyCapAction(TENANT, FORM, 10);
    expect(invalid).toMatchObject({ status: "error" });
    expect(JSON.stringify(invalid)).not.toContain("invalid_daily_cap");
    expect((invalid as { message: string }).message).toContain("entre 1 y 200");
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden" } });
    expect(await saveDailyCapAction(TENANT, FORM, 10)).toMatchObject({ kind: "forbidden" });
  });

  it("un formulario que no existe o es de otra organización responde «no encontrado» sin llamar a la base", async () => {
    requireActiveTenant.mockResolvedValue(active("owner", { data: null, error: null }));
    expect(await saveDailyCapAction(TENANT, FORM, 10)).toMatchObject({
      status: "error",
      kind: "not_found",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("si la base falla al leer, no dice que el formulario no existe", async () => {
    requireActiveTenant.mockResolvedValue(
      active("owner", { data: null, error: { code: "XX000", message: "boom" } }),
    );
    const result = await saveDailyCapAction(TENANT, FORM, 10);
    expect(result).toMatchObject({ status: "error", kind: "other" });
    expect((result as { message: string }).message).not.toMatch(/No encontramos/);
    expect(JSON.stringify(result)).not.toContain("boom");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("choque de revisión (CP409) y formulario archivado (CP423) tienen su propio mensaje", async () => {
    requireActiveTenant.mockResolvedValue(active("owner"));
    rpc.mockResolvedValue({ data: null, error: { code: "CP409", message: "revision_conflict" } });
    expect(await saveDailyCapAction(TENANT, FORM, 10)).toMatchObject({ kind: "conflict" });
    rpc.mockResolvedValue({ data: null, error: { code: "CP423", message: "form_archived" } });
    const archived = await saveDailyCapAction(TENANT, FORM, 10);
    expect(archived).toMatchObject({ status: "error" });
    expect(JSON.stringify(archived)).not.toContain("form_archived");
  });
});
