// @vitest-environment node
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";

// La sección de la ficha, del lado del servidor (H-042): qué lee y qué muestra según el rol de la persona.
const loadCatalogScope = vi.fn();
vi.mock("@/lib/team/catalog-scope-queries", () => ({
  loadCatalogScope: (...args: unknown[]) => loadCatalogScope(...args),
}));
vi.mock("@/components/team/catalog-scope-form", () => ({
  CatalogScopeForm: () => null,
}));

const { CatalogScopeSection } = await import("./catalog-scope-section");
const { CatalogScopeForm } = await import("@/components/team/catalog-scope-form");
const { NO_CATALOG_SCOPE } = await import("@/lib/team/catalog-scope-model");

const active = { tenantId: "t", role: "owner" } as unknown as ActiveTenant;
const base = { active, memberId: "m", memberName: "Carla" };
const ok = (scope = NO_CATALOG_SCOPE) => ({
  status: "ok" as const,
  scope,
  catalog: [],
  catalogTruncated: false,
});

beforeEach(() => loadCatalogScope.mockReset());

describe("CatalogScopeSection", () => {
  it("a un Comercial le muestra el formulario con la regla, el catálogo y el aviso de corte", async () => {
    loadCatalogScope.mockResolvedValue(ok());
    const element = (await CatalogScopeSection({ ...base, role: "sales" })) as ReactElement;
    expect(isValidElement(element)).toBe(true);
    expect(element.type).toBe(CatalogScopeForm);
    expect(element.props).toMatchObject({
      tenantId: "t",
      memberId: "m",
      memberName: "Carla",
      initial: NO_CATALOG_SCOPE,
      catalog: [],
      catalogTruncated: false,
    });
    // para quien se limita sí se lee el catálogo
    expect(loadCatalogScope).toHaveBeenCalledWith(active, "m", { withCatalog: true });
  });

  it.each(["owner", "admin", "approver", "viewer"])(
    "a %s no se le ofrecen controles, no se le lee el catálogo y se dice por qué",
    async (role) => {
      loadCatalogScope.mockResolvedValue(ok());
      const element = (await CatalogScopeSection({ ...base, role })) as ReactElement;
      expect(element.type).not.toBe(CatalogScopeForm);
      expect(loadCatalogScope).toHaveBeenCalledWith(active, "m", { withCatalog: false });
      const html = renderToStaticMarkup(element);
      expect(html).toContain("Servicios que puede cotizar");
      expect(html).toContain(
        role === "owner" || role === "admin" ? "no tiene límite de servicios" : "no cotiza",
      );
      expect(html).not.toContain("<form");
    },
  );

  it("si quedó una lista guardada de antes en alguien que ya no se limita, lo avisa", async () => {
    loadCatalogScope.mockResolvedValue(ok({ ...NO_CATALOG_SCOPE, mode: "list", revision: 2 }));
    const html = renderToStaticMarkup(
      (await CatalogScopeSection({ ...base, role: "admin" })) as ReactElement,
    );
    expect(html).toContain("Tiene una lista guardada que se aplicará si vuelve a ser Comercial.");
  });

  it("si no se pudo leer, un aviso de error (y nunca los controles), también para un Comercial", async () => {
    loadCatalogScope.mockResolvedValue({ status: "error" });
    for (const role of ["sales", "admin"]) {
      const element = (await CatalogScopeSection({ ...base, role })) as ReactElement;
      expect(element.type).not.toBe(CatalogScopeForm);
      const html = renderToStaticMarkup(element);
      expect(html).toContain("No pudimos cargar los servicios. Recarga la página en unos minutos.");
      expect(html).toContain('role="alert"');
    }
  });
});
