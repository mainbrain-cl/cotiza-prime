import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_ROLES, NO_PERMISSION_MESSAGE, can } from "@/lib/permissions/matrix";

// Guardar los servicios que puede cotizar un miembro (H-042) con un falso miembro de cada rol: quien no maneja el equipo recibe el
// mensaje único y la base NI SE CONSULTA; quien sí llega a `set_member_catalog_scope` con lo ya validado.

const TENANT_ID = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0001";
const MEMBER = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0011";
const ITEM_A = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0021";
const ITEM_B = "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0022";
const rpc = vi.fn();
const revalidatePath = vi.fn();
let role = "owner";

vi.mock("next/cache", () => ({
  revalidatePath: (path: string, type?: string) => revalidatePath(path, type),
}));
vi.mock("@/lib/tenant/active-tenant", () => ({
  requireActiveTenant: vi.fn(async () => ({
    tenantId: TENANT_ID,
    role,
    userId: "7f1d6b1c-9f6e-4c57-8c43-3b6a9b8f0002",
    supabase: { rpc },
  })),
}));

const { saveCatalogScopeAction } = await import("./catalog-scope-actions");
const model = await import("./catalog-scope-model");

const logged: string[] = [];
beforeEach(() => {
  role = "owner";
  rpc.mockReset();
  revalidatePath.mockReset();
  logged.length = 0;
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

const list = { memberId: MEMBER, mode: "list", itemIds: [ITEM_A, ITEM_B], expectedRevision: 0 };

describe("quien no maneja el equipo no llega a la base", () => {
  const without = MEMBER_ROLES.filter((r) => !can(r, "team.manage"));
  it("son Aprobador, Comercial y Observador", () => {
    expect(without).toHaveLength(3);
  });
  it.each(without)("%s: «sin permiso» y no se consulta nada", async (r) => {
    role = r;
    expect(await saveCatalogScopeAction(TENANT_ID, list)).toEqual({
      status: "error",
      kind: "forbidden",
      message: NO_PERMISSION_MESSAGE,
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("quien maneja el equipo guarda la regla", () => {
  it.each(MEMBER_ROLES.filter((r) => can(r, "team.manage")))(
    "%s llega a set_member_catalog_scope con lo validado y la pantalla se rehace",
    async (r) => {
      role = r;
      rpc.mockResolvedValue({
        data: { result: "changed", revision: 1, mode: "list", count: 2 },
        error: null,
      });
      expect(await saveCatalogScopeAction(TENANT_ID, list)).toEqual({
        status: "ok",
        result: "changed",
        revision: 1,
        mode: "list",
        count: 2,
      });
      expect(rpc).toHaveBeenCalledWith("set_member_catalog_scope", {
        p_member_id: MEMBER,
        p_mode: "list",
        p_catalog_item_ids: [ITEM_A, ITEM_B],
        p_expected_revision: 0,
      });
      expect(revalidatePath).toHaveBeenCalledWith(`/o/${TENANT_ID}/equipo`, "layout");
    },
  );

  it("los repetidos no se mandan y «todos» manda la lista nula", async () => {
    rpc.mockResolvedValue({
      data: { result: "changed", revision: 2, mode: "all", count: 0 },
      error: null,
    });
    await saveCatalogScopeAction(TENANT_ID, { ...list, itemIds: [ITEM_A, ITEM_A, ITEM_B] });
    expect(rpc).toHaveBeenLastCalledWith(
      "set_member_catalog_scope",
      expect.objectContaining({ p_catalog_item_ids: [ITEM_A, ITEM_B] }),
    );
    await saveCatalogScopeAction(TENANT_ID, { ...list, mode: "all", itemIds: [] });
    expect(rpc).toHaveBeenLastCalledWith("set_member_catalog_scope", {
      p_member_id: MEMBER,
      p_mode: "all",
      p_catalog_item_ids: null,
      p_expected_revision: 0,
    });
  });

  it("«ya estaba guardado» es un éxito y no rehace la pantalla", async () => {
    rpc.mockResolvedValue({
      data: { result: "unchanged", revision: 1, mode: "list", count: 2 },
      error: null,
    });
    expect(await saveCatalogScopeAction(TENANT_ID, list)).toMatchObject({
      status: "ok",
      result: "unchanged",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("lo inválido se rechaza antes de llamar a la base", () => {
  it.each([
    ["lista vacía", { ...list, itemIds: [] }, model.EMPTY_LIST_MESSAGE],
    [
      "más de 500",
      {
        ...list,
        itemIds: Array.from(
          { length: 501 },
          (_, i) => `7f1d6b1c-9f6e-4c57-8c43-${String(i).padStart(12, "0")}`,
        ),
      },
      model.TOO_MANY_ITEMS_MESSAGE,
    ],
    ["modo inventado", { ...list, mode: "otro" }, "Elige una de las dos opciones."],
    ["persona inválida", { ...list, memberId: "no" }, "Esta persona ya no está en tu equipo."],
    ["no es un objeto", "hola", undefined],
    ["versión negativa", { ...list, expectedRevision: -1 }, undefined],
  ])("%s", async (_name, input, message) => {
    const result = await saveCatalogScopeAction(TENANT_ID, input);
    expect(result).toMatchObject({ status: "error", kind: "invalid" });
    if (message && result.status === "error") expect(result.message).toBe(message);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("los errores de la base se dicen sin detalle técnico", () => {
  it("una versión vieja (CP409) dice que otra persona la cambió, y no se rehace la pantalla", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "CP409", message: "revision_changed" } });
    expect(await saveCatalogScopeAction(TENANT_ID, list)).toEqual({
      status: "error",
      kind: "conflict",
      message: model.CATALOG_SCOPE_CONFLICT_MESSAGE,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("un rechazo esperado no se registra", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden" } });
    expect(await saveCatalogScopeAction(TENANT_ID, list)).toMatchObject({ kind: "forbidden" });
    expect(logged).toEqual([]);
  });

  it("un fallo inesperado se dice sin detalle técnico y solo se registra el código", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "secreto interno" } });
    expect(await saveCatalogScopeAction(TENANT_ID, list)).toEqual({
      status: "error",
      kind: "other",
      message: model.CATALOG_SCOPE_GENERIC_FAILURE,
    });
    expect(logged.join(" ")).toContain("XX000");
    expect(logged.join(" ")).not.toContain("secreto interno");
  });

  it("una respuesta con otra forma no se da por buena", async () => {
    rpc.mockResolvedValue({ data: { result: "sí" }, error: null });
    expect(await saveCatalogScopeAction(TENANT_ID, list)).toMatchObject({
      status: "error",
      kind: "other",
      message: model.CATALOG_SCOPE_GENERIC_FAILURE,
    });
  });
});
