import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin-client", () => ({
  createAdminClient: () => ({ rpc, storage: { from: () => ({}) } }),
}));
vi.mock("@/lib/http/request-context", () => ({
  getRequestContext: async () => ({ requestId: "req-1", clientIp: "203.0.113.9", userAgent: "UA" }),
}));
vi.mock("@/lib/crypto/pii", () => ({ encryptPii: () => "x" }));
vi.mock("@/lib/crypto/search-hash", () => ({ searchHash: () => "x" }));

import { clearFrameAncestorsCache, readFrameAncestors, readIntakeForm } from "./gateway";

const PUBLIC_ID = "A".repeat(22);
const baseRead = {
  tenant_id: "11111111-1111-4111-8111-111111111111",
  form_id: "22222222-2222-4222-8222-222222222222",
  title: "Pide tu cotización",
  org: { name: "Empresa", contact_email: "c@ejemplo.test", contact_phone: null },
  brand: { primary_color: "#2B54E0", secondary_color: null },
  logo_path: null,
};
const okRead = (origins: unknown) => ({
  data: {
    ...baseRead,
    state: "ok",
    revision: 1,
    intro: "",
    success_message: "",
    fields: {
      phone: "off",
      company: "off",
      comuna: "off",
      serviceAddress: "off",
      desiredDate: "off",
      message: "off",
    },
    privacy_policy_url: null,
    embed_origins: origins,
    items: [],
  },
  error: null,
});

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: null, error: null });
  clearFrameAncestorsCache();
});

describe("el portero: sitios autorizados para incrustar (H-093)", () => {
  it("identificador mal formado: lista vacía sin tocar la base", async () => {
    expect(await readFrameAncestors("corto")).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("devuelve los sitios válidos del formulario, llamando solo a intake_form_read", async () => {
    rpc.mockResolvedValue(okRead(["https://sitio-permitido.test", "https://otro.cl"]));
    expect(await readFrameAncestors(PUBLIC_ID)).toEqual([
      "https://sitio-permitido.test",
      "https://otro.cl",
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("intake_form_read", { p_public_id: PUBLIC_ID });
  });

  it("lista con algo inválido, demasiado larga, o formulario inexistente: vacía", async () => {
    rpc.mockResolvedValue(okRead(["https://ok.cl", "*"]));
    expect(await readFrameAncestors(PUBLIC_ID)).toEqual([]);
    clearFrameAncestorsCache();
    rpc.mockResolvedValue(okRead(Array.from({ length: 11 }, (_, i) => `https://s${i}.cl`)));
    expect(await readFrameAncestors(PUBLIC_ID)).toEqual([]);
    clearFrameAncestorsCache();
    rpc.mockResolvedValue({ data: { state: "not_found" }, error: null });
    expect(await readFrameAncestors(PUBLIC_ID)).toEqual([]);
  });

  it("en pausa también entrega los sitios (el marco debe poder mostrar el aviso); sin la lista, vacía", async () => {
    rpc.mockResolvedValue({
      data: { ...baseRead, state: "paused", embed_origins: ["https://sitio-permitido.test"] },
      error: null,
    });
    expect(await readFrameAncestors(PUBLIC_ID)).toEqual(["https://sitio-permitido.test"]);
    clearFrameAncestorsCache();
    rpc.mockResolvedValue({ data: { ...baseRead, state: "paused" }, error: null });
    expect(await readFrameAncestors(PUBLIC_ID)).toEqual([]);
  });

  it("lo que va al navegador (readIntakeForm) nunca lleva la lista de sitios, ni en pausa", async () => {
    rpc.mockResolvedValue(okRead(["https://sitio-permitido.test"]));
    expect(JSON.stringify(await readIntakeForm(PUBLIC_ID))).not.toContain("sitio-permitido");
    rpc.mockResolvedValue({
      data: { ...baseRead, state: "paused", embed_origins: ["https://sitio-permitido.test"] },
      error: null,
    });
    const paused = await readIntakeForm(PUBLIC_ID);
    expect(paused.state).toBe("paused");
    expect(JSON.stringify(paused)).not.toContain("sitio-permitido");
    expect(JSON.stringify(paused)).not.toContain("embed");
  });

  it("si la lectura falla devuelve vacía y no recuerda el fallo", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000" } });
    expect(await readFrameAncestors(PUBLIC_ID)).toEqual([]);
    rpc.mockResolvedValueOnce(okRead(["https://sitio.cl"]));
    expect(await readFrameAncestors(PUBLIC_ID)).toEqual(["https://sitio.cl"]);
  });

  it("recuerda 60 s y luego vuelve a leer", async () => {
    rpc.mockResolvedValue(okRead(["https://sitio.cl"]));
    const t0 = 1_000_000;
    await readFrameAncestors(PUBLIC_ID, t0);
    await readFrameAncestors(PUBLIC_ID, t0 + 59_000);
    expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockResolvedValue(okRead([]));
    expect(await readFrameAncestors(PUBLIC_ID, t0 + 60_001)).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("muchos identificadores distintos no hacen crecer la memoria sin límite (sigue funcionando)", async () => {
    rpc.mockResolvedValue({ data: { state: "not_found" }, error: null });
    const t0 = 5_000_000;
    for (let i = 0; i < 700; i += 1) {
      expect(await readFrameAncestors(String(i).padStart(22, "B"), t0)).toEqual([]);
    }
    expect(rpc).toHaveBeenCalledTimes(700);
    // el más reciente sigue recordado; el más antiguo ya se descartó
    await readFrameAncestors(String(699).padStart(22, "B"), t0 + 1);
    expect(rpc).toHaveBeenCalledTimes(700);
    await readFrameAncestors(String(0).padStart(22, "B"), t0 + 1);
    expect(rpc).toHaveBeenCalledTimes(701);
  });
});
