import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { calculateQuote } from "./calc";
import { calcIssueFieldErrors, toCalcInput, toSaveRpcArgs } from "./payload";
import { payloadFieldErrors, saveQuotePayloadSchema, type SaveQuotePayload } from "./schemas";

const item = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  catalogItemId: null,
  name: "Flete",
  description: null,
  unit: "service",
  taxTreatment: "taxable",
  quantityMilli: 2500,
  unitPriceClp: 18_000,
  discount: { kind: "percent", bp: 1000 },
  ...over,
});

const payload = (over: Record<string, unknown> = {}) => ({
  saveId: randomUUID(),
  expectedRevision: 1,
  customerId: randomUUID(),
  globalDiscount: { kind: "none" },
  validity: { mode: "days", days: 15 },
  observations: null,
  conditions: null,
  items: [item()],
  ...over,
});

describe("saveQuotePayloadSchema", () => {
  it("acepta un guardado completo", () => {
    expect(saveQuotePayloadSchema.safeParse(payload()).success).toBe(true);
  });

  it.each([
    ["cantidad 0", { items: [item({ quantityMilli: 0 })] }],
    ["cantidad decimal", { items: [item({ quantityMilli: 1.5 })] }],
    ["cantidad sobre el tope", { items: [item({ quantityMilli: 1_000_000_001 })] }],
    ["precio negativo", { items: [item({ unitPriceClp: -1 })] }],
    ["precio decimal", { items: [item({ unitPriceClp: 10.5 })] }],
    ["precio como texto", { items: [item({ unitPriceClp: "100" })] }],
    ["precio sobre el tope", { items: [item({ unitPriceClp: 10 ** 12 + 1 })] }],
    ["nombre vacío", { items: [item({ name: "   " })] }],
    ["nombre muy largo", { items: [item({ name: "x".repeat(151) })] }],
    ["unidad inventada", { items: [item({ unit: "parsec" })] }],
    ["trato tributario inventado", { items: [item({ taxTreatment: "otro" })] }],
    ["descuento % sobre 100", { items: [item({ discount: { kind: "percent", bp: 10_001 } })] }],
    ["descuento $ negativo", { items: [item({ discount: { kind: "amount", clp: -1 } })] }],
    ["descuento 'none' con valor", { items: [item({ discount: { kind: "none", bp: 5 } })] }],
    ["descuento desconocido", { items: [item({ discount: { kind: "magia" } })] }],
    ["descuento global malo", { globalDiscount: { kind: "percent", bp: -5 } }],
    ["id de línea que no es UUID", { items: [item({ id: "no-es-uuid" })] }],
    ["cliente que no es UUID", { customerId: "x" }],
    ["revisión 0", { expectedRevision: 0 }],
    ["clave de guardado mala", { saveId: "x" }],
    ["demasiadas líneas", { items: Array.from({ length: 201 }, () => item()) }],
    ["vigencia 0 días", { validity: { mode: "days", days: 0 } }],
    ["vigencia 366 días", { validity: { mode: "days", days: 366 } }],
    ["vigencia decimal", { validity: { mode: "days", days: 1.5 } }],
    ["vigencia con fecha inexistente", { validity: { mode: "date", date: "2026-02-30" } }],
    ["vigencia con fecha mal escrita", { validity: { mode: "date", date: "05-10-2026" } }],
    ["vigencia con modo inventado", { validity: { mode: "forever" } }],
    ["vigencia sin modo", { validity: { days: 15 } }],
    ["observaciones sobre 4.000", { observations: "x".repeat(4001) }],
    ["condiciones sobre 4.000", { conditions: "x".repeat(4001) }],
    ["observaciones que no son texto", { observations: 5 }],
    ["campo de más (organización)", { tenantId: randomUUID() }],
    ["campo de más en la línea", { items: [item({ unitCostClp: 5 })] }],
  ])("rechaza: %s", (_name, over) => {
    expect(saveQuotePayloadSchema.safeParse(payload(over)).success).toBe(false);
  });

  it("acepta exactamente 200 líneas y los topes", () => {
    const lines = Array.from({ length: 200 }, () =>
      item({ quantityMilli: 1_000_000_000, unitPriceClp: 10 ** 12, discount: { kind: "none" } }),
    );
    expect(saveQuotePayloadSchema.safeParse(payload({ items: lines })).success).toBe(true);
  });

  it("los errores salen por campo, con la posición de la línea", () => {
    const result = saveQuotePayloadSchema.safeParse(
      payload({ items: [item(), item({ quantityMilli: 0 })] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(Object.keys(payloadFieldErrors(result.error))).toContain("items.1.quantityMilli");
    }
  });
});

describe("del guardado a la base", () => {
  const parsed = saveQuotePayloadSchema.parse(
    payload({
      items: [
        item(),
        item({ taxTreatment: "exempt", discount: { kind: "amount", clp: 500 }, description: "" }),
        item({ discount: { kind: "none" }, catalogItemId: randomUUID() }),
      ],
      globalDiscount: { kind: "percent", bp: 500 },
    }),
  ) as SaveQuotePayload;

  it("los argumentos de la función no llevan organización ni costos, y el descuento 'none' va con 0", () => {
    const calc = calculateQuote(toCalcInput(parsed, 1900));
    if (!calc.ok) throw new Error("debía calcular");
    const args = toSaveRpcArgs(randomUUID(), parsed, calc.totals);
    expect(Object.keys(args).sort()).toEqual([
      "p_expected_revision",
      "p_expected_totals",
      "p_header",
      "p_items",
      "p_quote_id",
      "p_save_id",
    ]);
    expect(JSON.stringify(args)).not.toMatch(/tenant|cost/i);
    expect(args.p_header.global_discount).toEqual({ kind: "percent", value: 500 });
    expect(args.p_header.validity).toEqual({ mode: "days", days: 15 });
    expect(args.p_header.observations).toBeNull();
    expect(args.p_header.conditions).toBeNull();
    expect(args.p_items.map((i) => [i.discount_kind, i.discount_value])).toEqual([
      ["percent", 1000],
      ["amount", 500],
      ["none", 0],
    ]);
    expect(args.p_items[1].description).toBeNull();
    expect(args.p_expected_totals).toBe(calc.totals);
  });

  it("los problemas del cálculo se asignan al campo correcto", () => {
    expect(
      calcIssueFieldErrors([
        { code: "invalid_quantity", lineIndex: 2 },
        { code: "line_discount_exceeds_gross", lineIndex: 0 },
        { code: "line_gross_too_large", lineIndex: 1 },
        { code: "global_discount_exceeds_subtotal", lineIndex: null },
        { code: "total_too_large", lineIndex: null },
      ]),
    ).toEqual({
      "items.2.quantity": "Revisa la cantidad: debe ser mayor que 0.",
      "items.0.discount": "El descuento es mayor que el total de la línea.",
      "items.1.price": "El total de la línea es demasiado alto. Revisa los ceros.",
      globalDiscount: "El descuento global es mayor que el subtotal.",
      form: "El total de la cotización es demasiado alto. Revisa los ceros.",
    });
  });
});
