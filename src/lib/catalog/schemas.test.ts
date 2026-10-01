import { describe, expect, it } from "vitest";
import { createCatalogItemSchema, parseCatalogStatusFilter } from "./schemas";

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
  it("acepta cambiar precio, unidad e IVA al editar", () => {
    const result = createCatalogItemSchema.safeParse({
      ...valid,
      unitPriceClp: "19.990",
      unit: "hour",
      taxTreatment: "exempt",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        unitPriceClp: 19990,
        unit: "hour",
        taxTreatment: "exempt",
      });
    }
  });
});

describe("parseCatalogStatusFilter", () => {
  it.each(["activos", "inactivos", "todos"])("acepta %j", (value) => {
    expect(parseCatalogStatusFilter(value)).toBe(value);
  });
  it.each([undefined, "", "borrados", ["todos"], 3])("vuelve a activos con %j", (value) => {
    expect(parseCatalogStatusFilter(value)).toBe("activos");
  });
});
