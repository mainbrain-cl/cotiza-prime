import { describe, expect, it } from "vitest";
import {
  CONFIGURABLE_FIELDS,
  DEFAULT_FIELD_MODES,
  SUGGESTED_FIELD_MODES,
  freeItem,
  isSuggestedMode,
  itemFromCatalog,
  looksLikePrice,
  moveItem,
  publicFormUrl,
  toSavePayload,
  type EditorForm,
} from "./builder-model";

describe("looksLikePrice", () => {
  it.each([
    "Desde $45.000",
    "$ 1200",
    "45.000 pesos",
    "Tarifa 280.000",
    "Valor en CLP",
    "clp 5000",
    "Cobro en UF por mes",
    "1.200.000",
  ])("avisa de «%s»", (text) => {
    expect(looksLikePrice(text)).toBe(true);
  });

  it.each([
    "Flete urbano",
    "Dentro de la Región Metropolitana",
    "Hasta 3 camiones",
    "Camión de 3,5 toneladas",
    "Mudanza completa en 2 días",
    "ufano y aufa",
    "",
  ])("no avisa de «%s»", (text) => {
    expect(looksLikePrice(text)).toBe(false);
  });
});

describe("lo mínimo sugerido", () => {
  it("coincide con los valores por defecto y se reconoce por campo", () => {
    expect(SUGGESTED_FIELD_MODES).toEqual(DEFAULT_FIELD_MODES);
    expect(isSuggestedMode("phone", "optional")).toBe(true);
    expect(isSuggestedMode("phone", "required")).toBe(false);
    expect(isSuggestedMode("company", "off")).toBe(true);
  });
});

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const CATALOG_ID = "33333333-3333-4333-8333-333333333333";

const baseForm: EditorForm = {
  name: "  Fletes en la web ",
  title: " Pide tu cotización ",
  intro: "",
  successMessage: "",
  fields: DEFAULT_FIELD_MODES,
  privacyPolicyUrl: "  ",
  items: [],
};

describe("itemFromCatalog", () => {
  it("copia nombre, descripción y unidad, y no arrastra ningún precio", () => {
    // Aunque alguien le pase un objeto con más datos (como el precio), solo se copian tres campos.
    const choice = {
      id: CATALOG_ID,
      name: "Flete urbano",
      description: null,
      unit: "service",
      unit_price_clp: 45000,
    };
    const item = itemFromCatalog(choice, ID_A);
    expect(item).toMatchObject({
      id: ID_A,
      kind: "catalog",
      catalogItemId: CATALOG_ID,
      publicName: "Flete urbano",
      publicDescription: "",
      unit: "service",
    });
    expect(JSON.stringify(item)).not.toMatch(/price|clp|45000|tarif|amount|margin|cost/i);
  });

  it("una unidad desconocida cae en servicio", () => {
    expect(
      itemFromCatalog({ id: CATALOG_ID, name: "X", description: null, unit: "raro" }, ID_A).unit,
    ).toBe("service");
  });
});

describe("moveItem", () => {
  it("sube y baja, y en los bordes no cambia nada", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a"], 5, 1)).toEqual(["a"]);
  });

  it("no modifica la lista original", () => {
    const original = ["a", "b"];
    moveItem(original, 0, 1);
    expect(original).toEqual(["a", "b"]);
  });
});

describe("toSavePayload", () => {
  it("limpia los textos y no manda sitios para incrustar, tope diario ni claves de precio", () => {
    const payload = toSavePayload({
      ...baseForm,
      items: [
        itemFromCatalog(
          { id: CATALOG_ID, name: "Flete", description: "Dentro de la RM", unit: "km" },
          ID_A,
        ),
        { ...freeItem(ID_B), publicName: " Mudanza ", quantityMode: "none" },
      ],
    });
    expect(payload.form).toEqual({
      name: "Fletes en la web",
      title: "Pide tu cotización",
      intro: "",
      success_message: "",
      fields: DEFAULT_FIELD_MODES,
      privacy_policy_url: null,
    });
    expect(Object.keys(payload.form)).not.toContain("embed_origins");
    expect(Object.keys(payload.form)).not.toContain("daily_cap");
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0]).toMatchObject({
      kind: "catalog",
      catalog_item_id: CATALOG_ID,
      unit: "km",
    });
    expect(payload.items[1]).toMatchObject({
      kind: "free",
      catalog_item_id: null,
      public_name: "Mudanza",
      public_description: null,
      quantity_mode: "none",
      is_active: true,
    });
    expect(JSON.stringify(payload)).not.toMatch(/price|clp|tarif|amount|margin|cost/i);
  });
});

describe("campos configurables", () => {
  it("no existe el RUT ni preguntas libres: la lista es cerrada", () => {
    const keys = CONFIGURABLE_FIELDS.map((f) => f.key).sort();
    expect(keys).toEqual(
      ["comuna", "company", "desiredDate", "message", "phone", "serviceAddress"].sort(),
    );
    expect(JSON.stringify(CONFIGURABLE_FIELDS).toLowerCase()).not.toContain("rut");
  });
});

describe("publicFormUrl", () => {
  it("arma la dirección con el origen configurado, sin barras dobles", () => {
    expect(publicFormUrl("https://app.ejemplo.cl/", "abcDEF1234567890abcDEF")).toBe(
      "https://app.ejemplo.cl/f/abcDEF1234567890abcDEF",
    );
  });
});
