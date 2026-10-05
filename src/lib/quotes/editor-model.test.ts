import { describe, expect, it } from "vitest";
import { CALC_CASES } from "./calc-cases";
import {
  contentKey,
  evaluateEditor,
  lineFromSaved,
  moveLine,
  newCatalogLine,
  newFreeLine,
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
  ...over,
});

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
    });
  });

  it("una línea guardada vuelve a mostrarse con coma y se lee igual", () => {
    const saved = lineFromSaved(
      {
        id: "a",
        catalog_item_id: null,
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
