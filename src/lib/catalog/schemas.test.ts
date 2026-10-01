import { describe, expect, it } from "vitest";
import { createCatalogItemSchema } from "./schemas";

const valid = {
  name: "  Flete Santiago  ",
  description: "",
  unit: "service",
  unitPriceClp: "$1.250.000",
  taxTreatment: "taxable",
};

describe("createCatalogItemSchema", () => {
  it("normaliza nombre, descripción vacía y precio", () => {
    const result = createCatalogItemSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        name: "Flete Santiago",
        description: null,
        unit: "service",
        unitPriceClp: 1250000,
        taxTreatment: "taxable",
      });
    }
  });
  it("exige nombre", () => {
    expect(createCatalogItemSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });
  it("rechaza unidades fuera de la lista cerrada", () => {
    expect(createCatalogItemSchema.safeParse({ ...valid, unit: "galon" }).success).toBe(false);
  });
  it("rechaza IVA desconocido", () => {
    expect(createCatalogItemSchema.safeParse({ ...valid, taxTreatment: "otro" }).success).toBe(
      false,
    );
  });
  it.each(["10,5", "-100", "", "abc"])("rechaza el precio %j", (unitPriceClp) => {
    expect(createCatalogItemSchema.safeParse({ ...valid, unitPriceClp }).success).toBe(false);
  });
  it("acepta precio cero", () => {
    expect(createCatalogItemSchema.safeParse({ ...valid, unitPriceClp: "0" }).success).toBe(true);
  });
});
