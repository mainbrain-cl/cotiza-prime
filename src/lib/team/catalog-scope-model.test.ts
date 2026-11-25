import { describe, expect, it } from "vitest";
import { MEMBER_ROLES } from "@/lib/permissions/matrix";
import {
  CATALOG_SCOPE_MAX_ITEMS,
  EMPTY_LIST_MESSAGE,
  NO_CATALOG_SCOPE,
  TOO_MANY_ITEMS_MESSAGE,
  filterCatalog,
  mapCatalogScopeError,
  notLimitableNote,
  roleCanBeLimited,
  saveCatalogScopeSchema,
  savedMessage,
  scopeProblem,
  scopeSummary,
  selectVisible,
  toggleSelection,
  type ScopeCatalogItem,
} from "./catalog-scope-model";

const item = (name: string, id = name, isActive = true): ScopeCatalogItem => ({
  id,
  name,
  unitLabel: "servicio",
  unitPriceClp: 10_000,
  isActive,
});
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("roleCanBeLimited (H-042)", () => {
  it("solo el Comercial: puede cotizar y no maneja el catálogo", () => {
    expect(MEMBER_ROLES.filter((role) => roleCanBeLimited(role))).toEqual(["sales"]);
  });
  it("un rol desconocido no se limita", () => {
    expect(roleCanBeLimited("inventado")).toBe(false);
    expect(roleCanBeLimited("")).toBe(false);
  });
});

describe("notLimitableNote", () => {
  it("el Dueño y el Administrador no tienen límite; el Aprobador y el Observador no cotizan", () => {
    expect(notLimitableNote("owner", false)).toBe("Su rol no tiene límite de servicios.");
    expect(notLimitableNote("admin", false)).toBe("Su rol no tiene límite de servicios.");
    expect(notLimitableNote("approver", false)).toBe("Su rol no cotiza.");
    expect(notLimitableNote("viewer", false)).toBe("Su rol no cotiza.");
  });
  it("si quedó una lista guardada de antes, lo dice", () => {
    expect(notLimitableNote("admin", true)).toBe(
      "Su rol no tiene límite de servicios. Tiene una lista guardada que se aplicará si vuelve a ser Comercial.",
    );
  });
  it("va de la mano de roleCanBeLimited: el que se limita nunca ve esta nota", () => {
    for (const role of MEMBER_ROLES) {
      if (roleCanBeLimited(role)) continue;
      expect(notLimitableNote(role, false)).toMatch(/^Su rol no /);
    }
  });
});

describe("el buscador y la selección", () => {
  const items = [
    item("Flete local"),
    item("Grúa"),
    item("Mudanza con ayudantes"),
    item("Flete Ñuñoa"),
  ];
  it("busca sin distinguir mayúsculas ni tildes, y vacío devuelve todo", () => {
    expect(filterCatalog(items, "").map((i) => i.name)).toHaveLength(4);
    expect(filterCatalog(items, "  FLETE ").map((i) => i.name)).toEqual([
      "Flete local",
      "Flete Ñuñoa",
    ]);
    expect(filterCatalog(items, "grua").map((i) => i.name)).toEqual(["Grúa"]);
    expect(filterCatalog(items, "nunoa").map((i) => i.name)).toEqual(["Flete Ñuñoa"]);
    expect(filterCatalog(items, "zzz")).toEqual([]);
  });
  it("marcar y desmarcar no cambia el conjunto original", () => {
    const base = new Set(["a"]);
    const next = toggleSelection(base, "b");
    expect([...base]).toEqual(["a"]);
    expect([...next].sort()).toEqual(["a", "b"]);
    expect([...toggleSelection(next, "a")]).toEqual(["b"]);
  });
  it("«Marcar los que se ven» suma a lo ya elegido, sin quitar nada", () => {
    const next = selectVisible(new Set(["Grúa"]), filterCatalog(items, "flete"));
    expect(next).toEqual(new Set(["Grúa", "Flete local", "Flete Ñuñoa"]));
  });
});

describe("la frase y los avisos", () => {
  it("«todos» y la lista, con el nombre y hasta tres servicios", () => {
    expect(scopeSummary("Carla", "all", [])).toBe("Carla puede cotizar todos los servicios");
    expect(scopeSummary("Carla", "list", ["Flete"])).toBe("Carla puede cotizar 1 servicio: Flete");
    expect(scopeSummary("Carla", "list", ["Flete", "Grúa"])).toBe(
      "Carla puede cotizar 2 servicios: Flete y Grúa",
    );
    expect(scopeSummary("Carla", "list", ["A", "B", "C"])).toBe(
      "Carla puede cotizar 3 servicios: A, B y C",
    );
    expect(scopeSummary("Carla", "list", ["A", "B", "C", "D", "E"])).toBe(
      "Carla puede cotizar 5 servicios: A, B, C y 2 más",
    );
    expect(scopeSummary("Carla", "list", [])).toBe("Carla no tiene servicios activos que cotizar");
  });
  it("el aviso al guardar", () => {
    expect(savedMessage("Carla", "all", 0)).toBe("Listo: Carla puede cotizar todos los servicios.");
    expect(savedMessage("Carla", "list", 1)).toBe("Listo: Carla solo puede cotizar 1 servicio.");
    expect(savedMessage("Carla", "list", 3)).toBe("Listo: Carla solo puede cotizar 3 servicios.");
  });
  it("sin regla es «todos», versión 0", () => {
    expect(NO_CATALOG_SCOPE).toMatchObject({ mode: "all", revision: 0, itemIds: [] });
  });
});

describe("qué se puede guardar", () => {
  it("lista vacía y más de 500 servicios no se guardan; «todos» siempre", () => {
    expect(scopeProblem("all", 0)).toBeNull();
    expect(scopeProblem("list", 0)).toBe(EMPTY_LIST_MESSAGE);
    expect(scopeProblem("list", 1)).toBeNull();
    expect(scopeProblem("list", CATALOG_SCOPE_MAX_ITEMS)).toBeNull();
    expect(scopeProblem("list", CATALOG_SCOPE_MAX_ITEMS + 1)).toBe(TOO_MANY_ITEMS_MESSAGE);
  });
  it("el esquema acepta lo bueno y rechaza lo malo con su mensaje", () => {
    const ok = {
      memberId: uuid(1),
      mode: "list",
      itemIds: [uuid(2), uuid(3)],
      expectedRevision: 0,
    };
    expect(saveCatalogScopeSchema.safeParse(ok).success).toBe(true);
    expect(saveCatalogScopeSchema.safeParse({ ...ok, mode: "all", itemIds: [] }).success).toBe(
      true,
    );
    const messages = (input: unknown) => {
      const result = saveCatalogScopeSchema.safeParse(input);
      return result.success ? [] : result.error.issues.map((i) => i.message);
    };
    expect(messages({ ...ok, itemIds: [] })).toContain(EMPTY_LIST_MESSAGE);
    expect(messages({ ...ok, mode: "all" })).toContain("Elige una de las dos opciones.");
    expect(messages({ ...ok, mode: "otro" })).toContain("Elige una de las dos opciones.");
    expect(messages({ ...ok, memberId: "no" })).toContain("Esta persona ya no está en tu equipo.");
    expect(messages({ ...ok, itemIds: ["no-es-uuid"] })).toHaveLength(1);
    expect(messages({ ...ok, expectedRevision: -1 })).toHaveLength(1);
    // los repetidos cuentan una sola vez
    expect(saveCatalogScopeSchema.safeParse({ ...ok, itemIds: [uuid(2), uuid(2)] }).success).toBe(
      true,
    );
    const many = Array.from({ length: CATALOG_SCOPE_MAX_ITEMS + 1 }, (_, i) => uuid(i + 10));
    expect(messages({ ...ok, itemIds: many })).toContain(TOO_MANY_ITEMS_MESSAGE);
  });
});

describe("mapCatalogScopeError", () => {
  it.each([
    ["42501", "forbidden", "forbidden"],
    ["CP404", "member_not_found", "not_found"],
    ["CP404", "not_found", "not_found"],
    ["CP409", "revision_changed", "conflict"],
    ["CP423", "cannot_target_self", "invalid"],
    ["CP422", "empty_list", "invalid"],
    ["CP422", "too_many_items", "invalid"],
    ["CP422", "catalog_item_not_found", "invalid"],
    ["CP422", "member_removed", "not_found"],
    ["CP422", "member_not_limitable", "not_limitable"],
    ["CP422", "invalid_mode", "other"],
    ["XX000", "boom", "other"],
  ])("%s «%s» → %s", (code, message, kind) => {
    const mapped = mapCatalogScopeError({ code, message });
    expect(mapped.kind).toBe(kind);
    expect(mapped.message).toMatch(/\S/);
    // nunca repite lo que dijo la base
    expect(mapped.message).not.toContain(message);
  });
});

describe("M-5: el rol cambió mientras se editaba", () => {
  it("dice de quién habla y qué hacer, no «su rol no tiene límite»", () => {
    const mapped = mapCatalogScopeError({ code: "CP422", message: "member_not_limitable" });
    expect(mapped.message).toBe(
      "Esta persona cambió de rol y ya no se le puede limitar. Recarga la página.",
    );
  });
});
