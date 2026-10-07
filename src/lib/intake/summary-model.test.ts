import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRequestSummary, formatSummaryDate, type SummaryConfig } from "./summary-model";

const CONFIG: SummaryConfig = {
  fields: {
    phone: "optional",
    company: "off",
    comuna: "optional",
    serviceAddress: "required",
    desiredDate: "optional",
    message: "optional",
  },
  items: [
    { id: "a", publicName: "Flete por kilómetro", unit: "km", quantityMode: "required" },
    { id: "b", publicName: "Embalaje", unit: null, quantityMode: "optional" },
    { id: "c", publicName: "Seguro de carga", quantityMode: "none" },
  ],
};

describe("buildRequestSummary", () => {
  it("un borrador vacío no muestra nada", () => {
    const summary = buildRequestSummary(CONFIG, {});
    expect(summary).toEqual({
      services: [],
      contact: [],
      details: [],
      itemCount: 0,
      isEmpty: true,
    });
  });

  it("muestra servicios con cantidad y unidad", () => {
    const summary = buildRequestSummary(CONFIG, {
      items: [
        { formItemId: "a", quantity: " 2,5 " },
        { formItemId: "b", quantity: "3" },
        { formItemId: "c", quantity: "99" },
      ],
    });
    expect(summary.services.map((l) => [l.label, l.value])).toEqual([
      ["Flete por kilómetro", "2,5 km"],
      ["Embalaje", "3"],
      ["Seguro de carga", ""],
    ]);
    expect(summary.itemCount).toBe(3);
    expect(summary.isEmpty).toBe(false);
  });

  it("ignora ítems desconocidos y repetidos", () => {
    const summary = buildRequestSummary(CONFIG, {
      items: [
        { formItemId: "zzz" },
        { formItemId: "a", quantity: "1" },
        { formItemId: "a", quantity: "2" },
      ],
    });
    expect(summary.services).toHaveLength(1);
    expect(summary.services[0].value).toBe("1 km");
  });

  it("solo muestra los datos de contacto que se piden y se escribieron", () => {
    const summary = buildRequestSummary(CONFIG, {
      name: "  Ana  ",
      email: "ana@empresa.cl",
      phone: "",
      company: "No se pide",
      comuna: "Ñuñoa",
      serviceAddress: "Calle 1",
    });
    expect(summary.contact.map((l) => [l.label, l.value])).toEqual([
      ["Nombre", "Ana"],
      ["Correo", "ana@empresa.cl"],
      ["Comuna", "Ñuñoa"],
      ["Dirección del servicio", "Calle 1"],
    ]);
  });

  it("fecha en formato chileno y mensaje con saltos de línea", () => {
    const summary = buildRequestSummary(CONFIG, {
      desiredDate: "2026-10-07",
      message: "Hola\nnecesito ayuda",
    });
    expect(summary.details).toEqual([
      { key: "desiredDate", section: "details", label: "Fecha deseada", value: "07-10-2026" },
      {
        key: "message",
        section: "details",
        label: "Mensaje",
        value: "Hola\nnecesito ayuda",
        multiline: true,
      },
    ]);
  });

  it("no muestra fecha ni mensaje si el campo está apagado", () => {
    const off = {
      ...CONFIG,
      fields: { ...CONFIG.fields, desiredDate: "off", message: "off" },
    } as SummaryConfig;
    expect(buildRequestSummary(off, { desiredDate: "2026-10-07", message: "x" }).details).toEqual(
      [],
    );
  });

  it("no tiene ningún campo de dinero aunque la configuración traiga precios", () => {
    const sneaky = {
      ...CONFIG,
      items: [{ ...CONFIG.items[0], unitPriceClp: 15000, price: 5, total: 9 }],
    } as unknown as SummaryConfig;
    const summary = buildRequestSummary(sneaky, { items: [{ formItemId: "a", quantity: "2" }] });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toMatch(/price|clp|total|\$|15000/i);
    expect(Object.keys(summary).sort()).toEqual(
      ["contact", "details", "isEmpty", "itemCount", "services"].sort(),
    );
  });

  it("devuelve texto plano: no interpreta nada", () => {
    const summary = buildRequestSummary(CONFIG, { name: "<img src=x onerror=alert(1)>" });
    expect(summary.contact[0].value).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("formatSummaryDate", () => {
  it("convierte y deja intacto lo que no es fecha", () => {
    expect(formatSummaryDate("2026-01-09")).toBe("09-01-2026");
    expect(formatSummaryDate("mañana")).toBe("mañana");
  });
});

describe("el módulo no puede importar dinero", () => {
  it("summary-model.ts no importa money, calc, parse ni el catálogo", () => {
    const source = readFileSync(path.join(__dirname, "summary-model.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      expect(spec).not.toMatch(/money|calc|catalog|quotes|parse/);
    }
  });
});
