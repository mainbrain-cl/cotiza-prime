import { describe, expect, it } from "vitest";
import { isActive } from "./nav-items";

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
