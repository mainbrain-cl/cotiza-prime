import { describe, expect, it } from "vitest";
import { NAV_ITEMS, isActive, visibleNavItems } from "./nav-items";

describe("isActive", () => {
  const base = "/o/abc";
  it("el inicio solo está activo en su propia dirección", () => {
    expect(isActive("/o/abc", base, "")).toBe(true);
    expect(isActive("/o/abc/clientes", base, "")).toBe(false);
  });
  it("una sección está activa en ella y en sus subpáginas, pero no en otra con el mismo prefijo", () => {
    expect(isActive("/o/abc/clientes", base, "clientes")).toBe(true);
    expect(isActive("/o/abc/clientes/42", base, "clientes")).toBe(true);
    expect(isActive("/o/abc/clientes-x", base, "clientes")).toBe(false);
  });
});

describe("visibleNavItems (el menú de cada rol)", () => {
  const segmentsOf = (role: string) => visibleNavItems(role).map((item) => item.segment);
  const EVERYTHING_BUT_SETTINGS = [
    "",
    "cotizaciones",
    "solicitudes",
    "clientes",
    "catalogo",
    "formularios",
  ];

  it("el Dueño y los Administradores ven todo, también «Configuración»", () => {
    for (const role of ["owner", "admin"]) {
      expect(segmentsOf(role)).toEqual([...EVERYTHING_BUT_SETTINGS, "configuracion"]);
    }
  });

  it("el Aprobador, el Comercial y el Observador no ven «Configuración»", () => {
    for (const role of ["approver", "sales", "viewer"]) {
      expect(segmentsOf(role)).toEqual(EVERYTHING_BUT_SETTINGS);
    }
  });

  it("un rol desconocido no ve ningún destino", () => {
    expect(segmentsOf("otro")).toEqual([]);
  });

  it("todo destino pide un permiso de la matriz", () => {
    for (const item of NAV_ITEMS) expect(typeof item.permission).toBe("string");
  });
});
