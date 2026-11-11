import { describe, expect, it } from "vitest";
import { CALC_CASES } from "./calc-cases";
import {
  contentKey,
  evaluateEditor,
  lineFromSaved,
  moveLine,
  newCatalogLine,
  newFreeLine,
  priceBelowCatalog,
  type EditorLine,
  type EditorState,
} from "./editor-model";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";

function line(id: string, over: Partial<EditorLine> = {}): EditorLine {
  return { ...newFreeLine(id), name: `Línea ${id}`, price: "10000", ...over };
}

const state = (lines: EditorLine[], over: Partial<EditorState> = {}): EditorState => ({
  customerId: CUSTOMER,
  lines,
  globalDiscountKind: "none",
  globalDiscount: "",
  validityMode: "days",
  validityDays: "15",
  validityDate: "",
  observations: "",
  conditions: "",
  ...over,
});

const CONTEXT = { today: "2026-10-05", savedValidUntil: null };

describe("evaluateEditor", () => {
  it("una línea con cantidad con coma da los mismos totales que el caso K04 (2,5 × 18.000)", () => {
    const view = evaluateEditor(state([line("a", { quantity: "2,5", price: "18.000" })]), 1900);
    const k04 = CALC_CASES.find((c) => c.id === "K04");
    expect(view.errors).toEqual({});
    expect(view.totals?.subtotalClp).toBe(45_000);
    expect(view.totals?.totalClp).toBe(53_550);
    expect(k04).toBeDefined();
  });

  it("exento aparte: la línea exenta no suma IVA", () => {
    const view = evaluateEditor(
      state([
        line("a", { price: "100000" }),
        line("b", { price: "50000", taxTreatment: "exempt" }),
      ]),
      1900,
    );
    expect(view.totals).toMatchObject({
      netTaxableClp: 100_000,
      netExemptClp: 50_000,
      taxClp: 19_000,
      totalClp: 169_000,
    });
  });

  it("descuento por línea en % y en $, y descuento global: Subtotal − descuento global + IVA = Total", () => {
    const view = evaluateEditor(
      state(
        [
          line("a", { quantity: "3", price: "10000", discountKind: "percent", discount: "10" }),
          line("b", { price: "5000", discountKind: "amount", discount: "1000" }),
        ],
        { globalDiscountKind: "percent", globalDiscount: "5" },
      ),
      1900,
    );
    const t = view.totals!;
    expect(t.subtotalClp).toBe(27_000 + 4_000);
    expect(t.subtotalClp - t.globalDiscountClp + t.taxClp).toBe(t.totalClp);
  });

  it.each([
    ["cantidad vacía", { quantity: "" }, "quantity"],
    ["cantidad con punto decimal", { quantity: "2.5" }, "quantity"],
    ["cantidad 0", { quantity: "0" }, "quantity"],
    ["cantidad con 4 decimales", { quantity: "1,2345" }, "quantity"],
    ["precio vacío", { price: "" }, "price"],
    ["precio decimal", { price: "10,5" }, "price"],
    ["precio negativo", { price: "-5" }, "price"],
    ["nombre vacío", { name: "  " }, "name"],
    [
      "porcentaje mayor a 100",
      { discountKind: "percent" as const, discount: "100,01" },
      "discount",
    ],
    ["descuento en $ vacío", { discountKind: "amount" as const, discount: "" }, "discount"],
  ])("%s: error en el campo y sin totales", (_label, over, field) => {
    const view = evaluateEditor(state([line("a", over)]), 1900);
    expect(view.errors[`items.0.${field}`]).toBeTruthy();
    expect(view.totals).toBeNull();
    expect(view.content).toBeNull();
  });

  it("descuento en $ mayor que el total de la línea: error en el descuento", () => {
    const view = evaluateEditor(
      state([line("a", { discountKind: "amount", discount: "10001" })]),
      1900,
    );
    expect(view.errors["items.0.discount"]).toMatch(/mayor/);
    expect(view.totals).toBeNull();
  });

  it("descuento global mayor que el subtotal: se rechaza, no se recorta", () => {
    const view = evaluateEditor(
      state([line("a")], { globalDiscountKind: "amount", globalDiscount: "10001" }),
      1900,
    );
    expect(view.errors.globalDiscount).toMatch(/mayor que el subtotal/);
  });

  it("sin líneas el total es 0", () => {
    const view = evaluateEditor(state([]), 1900);
    expect(view.totals?.totalClp).toBe(0);
    expect(view.content?.items).toEqual([]);
  });

  it("reordenar las líneas no cambia los totales", () => {
    const a = line("a", { price: "12345", quantity: "1,5" });
    const b = line("b", { price: "999", taxTreatment: "exempt" });
    const one = evaluateEditor(state([a, b]), 1900).totals!;
    const two = evaluateEditor(state([b, a]), 1900).totals!;
    expect({ ...one, lines: [] }).toEqual({ ...two, lines: [] });
  });

  it("contentKey cambia con cualquier cambio de contenido y no con uno de forma", () => {
    const base = evaluateEditor(state([line("a")]), 1900).content!;
    const same = evaluateEditor(state([line("a")]), 1900).content!;
    const changed = evaluateEditor(state([line("a", { price: "10001" })]), 1900).content!;
    expect(contentKey(base)).toBe(contentKey(same));
    expect(contentKey(base)).not.toBe(contentKey(changed));
  });
});

describe("líneas", () => {
  it("una línea del catálogo carga precio, unidad y trato tributario", () => {
    const created = newCatalogLine("x", {
      id: "cat-1",
      name: "Flete",
      description: "Urbano",
      unit: "km",
      unitPriceClp: 15_000,
      taxTreatment: "exempt",
    });
    expect(created).toMatchObject({
      catalogItemId: "cat-1",
      price: "15000",
      unit: "km",
      taxTreatment: "exempt",
      quantity: "1",
      catalogPriceClp: 15_000,
    });
  });

  it("avisa cuando el precio escrito es más bajo que el del catálogo", () => {
    const fromCatalog = (price: string) => ({ catalogPriceClp: 6500, price });
    expect(priceBelowCatalog(fromCatalog("3000"))).toBe(6500);
    expect(priceBelowCatalog(fromCatalog("6499"))).toBe(6500);
    expect(priceBelowCatalog(fromCatalog("6500"))).toBeNull();
    expect(priceBelowCatalog(fromCatalog("9000"))).toBeNull();
    expect(priceBelowCatalog(fromCatalog("0"))).toBe(6500);
    // El campo acepta puntos de miles, igual que al guardar.
    expect(priceBelowCatalog(fromCatalog("3.000"))).toBe(6500);
    expect(priceBelowCatalog(fromCatalog("6.500"))).toBeNull();
    // Vacío o ilegible: no hay rebaja que avisar (el error del campo ya lo dice la validación).
    expect(priceBelowCatalog(fromCatalog(""))).toBeNull();
    expect(priceBelowCatalog(fromCatalog("abc"))).toBeNull();
    expect(priceBelowCatalog(fromCatalog("-5"))).toBeNull();
    // Una línea libre no tiene precio de catálogo contra el que comparar.
    expect(priceBelowCatalog({ catalogPriceClp: null, price: "1" })).toBeNull();
  });

  it("una línea guardada conserva el precio de catálogo con que se cargó; la libre no", () => {
    const row = {
      id: "a",
      name: "Servicio",
      description: null,
      unit: "service",
      tax_treatment: "taxable" as const,
      quantity_milli: 1000,
      unit_price_clp: 3000,
      discount_kind: "none" as const,
      discount_value: 0,
    };
    expect(
      lineFromSaved({ ...row, catalog_item_id: "cat-1", catalog_unit_price_clp: 6500 }, false)
        .catalogPriceClp,
    ).toBe(6500);
    expect(
      lineFromSaved({ ...row, catalog_item_id: null, catalog_unit_price_clp: null }, false)
        .catalogPriceClp,
    ).toBeNull();
    expect(newFreeLine("z").catalogPriceClp).toBeNull();
  });

  it("una línea guardada vuelve a mostrarse con coma y se lee igual", () => {
    const saved = lineFromSaved(
      {
        id: "a",
        catalog_item_id: null,
        catalog_unit_price_clp: null,
        name: "Servicio",
        description: null,
        unit: "service",
        tax_treatment: "taxable",
        quantity_milli: 2500,
        unit_price_clp: 18_000,
        discount_kind: "percent",
        discount_value: 1250,
      },
      false,
    );
    expect(saved.quantity).toBe("2,5");
    expect(saved.discount).toBe("12,5");
    const view = evaluateEditor(state([saved]), 1900);
    expect(view.content?.items[0]).toMatchObject({
      quantityMilli: 2500,
      discount: { kind: "percent", bp: 1250 },
    });
  });

  it("mover una línea hacia arriba y abajo; en los bordes no hace nada", () => {
    const lines = [line("a"), line("b"), line("c")];
    expect(moveLine(lines, 2, -1).map((l) => l.id)).toEqual(["a", "c", "b"]);
    expect(moveLine(lines, 0, 1).map((l) => l.id)).toEqual(["b", "a", "c"]);
    expect(moveLine(lines, 0, -1)).toBe(lines);
    expect(moveLine(lines, 2, 1)).toBe(lines);
  });
});

describe("evaluateEditor · vigencia, observaciones y condiciones (H-027)", () => {
  const eval1 = (over: Partial<EditorState>, savedValidUntil: string | null = null) =>
    evaluateEditor(state([line("a")], over), 1900, { ...CONTEXT, savedValidUntil });

  it("la vigencia en días por defecto es válida y viaja al guardado", () => {
    const view = eval1({});
    expect(view.errors).toEqual({});
    expect(view.content?.validity).toEqual({ mode: "days", days: 15 });
    expect(view.content?.observations).toBeNull();
    expect(view.content?.conditions).toBeNull();
  });

  it.each([
    ["vacío", ""],
    ["cero", "0"],
    ["366", "366"],
    ["decimal", "7,5"],
    ["texto", "quince"],
    ["negativo", "-3"],
  ])("rechaza una vigencia en días inválida: %s", (_name, days) => {
    const view = eval1({ validityDays: days });
    expect(view.errors.validity).toBeTruthy();
    expect(view.content).toBeNull();
  });

  it("acepta 1 y 365 días", () => {
    expect(eval1({ validityDays: "1" }).content?.validity).toEqual({ mode: "days", days: 1 });
    expect(eval1({ validityDays: "365" }).content?.validity).toEqual({ mode: "days", days: 365 });
  });

  it("con fecha: acepta hoy y el futuro; rechaza el pasado y fechas inexistentes", () => {
    expect(eval1({ validityMode: "date", validityDate: "2026-10-05" }).errors).toEqual({});
    expect(eval1({ validityMode: "date", validityDate: "2026-12-31" }).content?.validity).toEqual({
      mode: "date",
      date: "2026-12-31",
    });
    expect(eval1({ validityMode: "date", validityDate: "2026-10-04" }).errors.validity).toMatch(
      /pasado/,
    );
    expect(
      eval1({ validityMode: "date", validityDate: "2026-02-30" }).errors.validity,
    ).toBeTruthy();
    expect(eval1({ validityMode: "date", validityDate: "" }).errors.validity).toBeTruthy();
  });

  it("una fecha pasada que ya estaba guardada se puede conservar", () => {
    const view = eval1({ validityMode: "date", validityDate: "2026-09-01" }, "2026-09-01");
    expect(view.errors).toEqual({});
  });

  it("observaciones y condiciones: se recortan, vacío es null y pasan de 4.000 caracteres se rechazan", () => {
    const ok = eval1({ observations: "  Entrega en bodega  ", conditions: "50% al aceptar" });
    expect(ok.content?.observations).toBe("Entrega en bodega");
    expect(ok.content?.conditions).toBe("50% al aceptar");
    expect(eval1({ observations: "   " }).content?.observations).toBeNull();
    expect(eval1({ observations: "x".repeat(4000) }).errors).toEqual({});
    expect(eval1({ observations: "x".repeat(4001) }).errors.observations).toBeTruthy();
    expect(eval1({ conditions: "x".repeat(4001) }).errors.conditions).toBeTruthy();
  });

  it("el HTML se trata como texto: no se interpreta ni se altera", () => {
    const view = eval1({ observations: "<script>alert(1)</script>" });
    expect(view.content?.observations).toBe("<script>alert(1)</script>");
  });

  it("descuento global mayor que el subtotal: mensaje claro en el campo", () => {
    const view = evaluateEditor(
      state([line("a", { price: "10000" })], {
        globalDiscountKind: "amount",
        globalDiscount: "10001",
      }),
      1900,
      CONTEXT,
    );
    expect(view.errors.globalDiscount).toMatch(/mayor que el subtotal/);
    expect(view.content).toBeNull();
  });
});
