import { describe, expect, it } from "vitest";
import {
  CONVERT_CUSTOMER_GONE,
  CONVERT_DISCARDED,
  CONVERT_FORBIDDEN,
  CONVERT_GENERIC_FAILURE,
  CONVERT_KEY_REUSED,
  CONVERT_NOT_FOUND,
  convertInputSchema,
  lineQuantityMilli,
  mapConvertError,
  parseRequestedServices,
  planLines,
  type CatalogSnapshot,
} from "./convert-model";

const CATALOG_A = "11111111-1111-4111-8111-111111111111";
const CATALOG_B = "22222222-2222-4222-8222-222222222222";
const FORM_ITEM = "33333333-3333-4333-8333-333333333333";

const catalog = (id: string, price = 10_000): CatalogSnapshot => ({
  id,
  name: `Servicio ${id.slice(0, 2)}`,
  description: null,
  unit: "km",
  unitPriceClp: price,
  taxTreatment: "taxable",
});

describe("parseRequestedServices", () => {
  it("lee la copia congelada de la solicitud y deja el servicio del catálogo", () => {
    const services = parseRequestedServices([
      {
        form_item_id: FORM_ITEM,
        catalog_item_id: CATALOG_A,
        name: "Flete",
        unit: "km",
        quantity_milli: 12_500,
      },
      { form_item_id: FORM_ITEM, catalog_item_id: null, name: "Libre", unit: "service" },
    ]);
    expect(services).toEqual([
      { name: "Flete", unit: "km", catalogItemId: CATALOG_A, quantityMilli: 12_500 },
      { name: "Libre", unit: "service", catalogItemId: null, quantityMilli: null },
    ]);
  });

  it("ignora lo que no calza: sin nombre, ids que no son UUID, entradas que no son objetos", () => {
    expect(parseRequestedServices(null)).toEqual([]);
    expect(parseRequestedServices("texto")).toEqual([]);
    const services = parseRequestedServices([
      null,
      "x",
      { name: "" },
      { name: "Con id roto", catalog_item_id: "no-es-uuid", unit: 5 },
    ]);
    expect(services).toEqual([
      { name: "Con id roto", unit: "", catalogItemId: null, quantityMilli: null },
    ]);
  });
});

describe("lineQuantityMilli", () => {
  it("usa la cantidad pedida, o 1 si no pidió cantidad", () => {
    expect(
      lineQuantityMilli({ name: "a", unit: "km", catalogItemId: null, quantityMilli: 3_000 }),
    ).toBe(3_000);
    expect(
      lineQuantityMilli({ name: "a", unit: "km", catalogItemId: null, quantityMilli: null }),
    ).toBe(1_000);
  });

  it("rechaza lo que el cotizador no aceptaría", () => {
    for (const quantityMilli of [0, -5, 1.5, 2_000_000_000]) {
      expect(
        lineQuantityMilli({ name: "a", unit: "km", catalogItemId: null, quantityMilli }),
      ).toBeNull();
    }
  });
});

describe("planLines", () => {
  const services = parseRequestedServices([
    { name: "Activo", unit: "km", catalog_item_id: CATALOG_A, quantity_milli: 2_000 },
    { name: "Desactivado", unit: "km", catalog_item_id: CATALOG_B, quantity_milli: 1_000 },
    { name: "Libre", unit: "service", catalog_item_id: null },
  ]);

  it("carga solo los del catálogo que siguen activos, con la cantidad pedida", () => {
    const plan = planLines(services, new Map([[CATALOG_A, catalog(CATALOG_A)]]));
    expect(plan.lines.map((l) => [l.catalog.id, l.quantityMilli])).toEqual([[CATALOG_A, 2_000]]);
  });

  it("avisa los desactivados y no convierte en línea los libres", () => {
    const plan = planLines(services, new Map([[CATALOG_A, catalog(CATALOG_A)]]));
    expect(plan.skipped.map((s) => s.name)).toEqual(["Desactivado"]);
    expect(plan.lines.some((l) => l.service.name === "Libre")).toBe(false);
    expect(plan.skipped.some((s) => s.name === "Libre")).toBe(false);
  });

  it("sin catálogo activo no hay líneas y todos los del catálogo quedan avisados", () => {
    const plan = planLines(services, new Map());
    expect(plan.lines).toEqual([]);
    expect(plan.skipped.map((s) => s.name)).toEqual(["Activo", "Desactivado"]);
  });

  it("usa el precio de HOY del catálogo, no uno guardado en la solicitud", () => {
    const plan = planLines(services, new Map([[CATALOG_A, catalog(CATALOG_A, 45_000)]]));
    expect(plan.lines[0].catalog.unitPriceClp).toBe(45_000);
  });
});

describe("convertInputSchema", () => {
  const id = "44444444-4444-4444-8444-444444444444";
  it("acepta cliente nuevo y cliente existente", () => {
    expect(
      convertInputSchema.safeParse({
        mode: "new",
        creationKey: id,
        confirmDuplicate: false,
        customer: { kind: "person", displayName: "A", rut: "", email: "", phone: "", address: "" },
      }).success,
    ).toBe(true);
    expect(
      convertInputSchema.safeParse({ mode: "existing", customerId: id, creationKey: id }).success,
    ).toBe(true);
  });

  it("rechaza identificadores que no son UUID, modos raros y datos de más o de menos", () => {
    expect(
      convertInputSchema.safeParse({ mode: "existing", customerId: "x", creationKey: id }).success,
    ).toBe(false);
    expect(
      convertInputSchema.safeParse({ mode: "otro", customerId: id, creationKey: id }).success,
    ).toBe(false);
    expect(convertInputSchema.safeParse({ mode: "new", creationKey: id }).success).toBe(false);
    expect(convertInputSchema.safeParse(null).success).toBe(false);
  });
});

describe("mapConvertError", () => {
  it("traduce cada código de la base sin detalle técnico", () => {
    expect(mapConvertError({ code: "42501", message: "forbidden" })).toEqual({
      kind: "forbidden",
      message: CONVERT_FORBIDDEN,
    });
    expect(mapConvertError({ code: "CP423", message: "discarded" })).toEqual({
      kind: "discarded",
      message: CONVERT_DISCARDED,
    });
    expect(mapConvertError({ code: "CP404", message: "request_not_found" })).toEqual({
      kind: "not_found",
      message: CONVERT_NOT_FOUND,
    });
    expect(mapConvertError({ code: "CP404", message: "customer_not_found" })).toEqual({
      kind: "customer",
      message: CONVERT_CUSTOMER_GONE,
    });
    expect(mapConvertError({ code: "CP422", message: "creation_key_reused" })).toEqual({
      kind: "key_reused",
      message: CONVERT_KEY_REUSED,
    });
  });

  it("lo desconocido da el mensaje genérico, sin el texto de la base", () => {
    for (const error of [
      { code: "XX000", message: 'relation "intake_requests" does not exist' },
      { code: "CP422", message: "invalid_arguments" },
      {},
    ]) {
      const mapped = mapConvertError(error);
      expect(mapped.kind).toBe("other");
      expect(mapped.message).toBe(CONVERT_GENERIC_FAILURE);
    }
  });
});
