import { describe, expect, it } from "vitest";
import {
  LINE_RULES_GENERIC_MESSAGE,
  lineRulesBlockMessage,
  lineRulesPrepareError,
  type SavedLineForRules,
  type SavedQuoteForRules,
} from "./line-rules-block";

const CAT = "11111111-1111-4111-8111-111111111111";

const item = (over: Partial<SavedLineForRules> = {}): SavedLineForRules => ({
  catalog_item_id: CAT,
  catalog_unit_price_clp: 10_000,
  unit_price_clp: 10_000,
  discount_kind: "none",
  discount_value: 0,
  gross_clp: 10_000,
  ...over,
});
const quote = (over: Partial<SavedQuoteForRules> = {}): SavedQuoteForRules => ({
  global_discount_kind: "none",
  global_discount_value: 0,
  subtotal_clp: 10_000,
  ...over,
});
const block = (
  items: SavedLineForRules[],
  over: {
    quote?: SavedQuoteForRules;
    locked?: string[];
    cap?: number | null;
    override?: boolean;
  } = {},
) =>
  lineRulesBlockMessage({
    items,
    quote: over.quote ?? quote(),
    lockedCatalogIds: new Set(over.locked ?? [CAT]),
    maxDiscountBp: over.cap === undefined ? 1_000 : over.cap,
    canOverride: over.override ?? false,
  });

describe("el bloqueo de /enviar por precio y descuento", () => {
  it("una cotización que cumple sale sin bloqueo", () => {
    expect(block([item()])).toBeNull();
    expect(block([item({ discount_kind: "percent", discount_value: 1_000 })])).toBeNull();
  });

  it("un precio bloqueado a otro precio dice qué línea (la 2) y qué hacer", () => {
    const message = block([item(), item({ unit_price_clp: 8_000, gross_clp: 8_000 })]);
    expect(message).toBe(
      "La línea 2 tiene un precio bloqueado distinto al precio con que se agregó. Vuelve a la cotización y usa ese precio.",
    );
  });

  it("el mismo precio distinto en un servicio SIN candado no bloquea", () => {
    expect(block([item({ unit_price_clp: 8_000, gross_clp: 8_000 })], { locked: [] })).toBeNull();
  });

  it("una línea libre no tiene candado", () => {
    expect(
      block([item({ catalog_item_id: null, catalog_unit_price_clp: null, unit_price_clp: 1 })]),
    ).toBeNull();
  });

  it("un descuento sobre el tope dice el máximo", () => {
    expect(block([item({ discount_kind: "percent", discount_value: 1_500 })])).toBe(
      "El descuento de la línea 1 pasa del máximo que permite tu organización. Máximo 10 %.",
    );
  });

  it("con tope 0 dice que no se permiten descuentos", () => {
    expect(block([item({ discount_kind: "amount", discount_value: 1 })], { cap: 0 })).toBe(
      "El descuento de la línea 1 pasa del máximo que permite tu organización. Tu organización no permite descuentos.",
    );
  });

  it("sin tope no hay límite de descuento", () => {
    expect(
      block([item({ discount_kind: "percent", discount_value: 9_000 })], { cap: null }),
    ).toBeNull();
  });

  it("el descuento general se mide sobre el subtotal guardado", () => {
    expect(
      block([item()], {
        quote: quote({ global_discount_kind: "amount", global_discount_value: 1_001 }),
      }),
    ).toMatch(/^El descuento general pasa del máximo/);
    expect(
      block([item()], {
        quote: quote({ global_discount_kind: "amount", global_discount_value: 1_000 }),
      }),
    ).toBeNull();
  });

  it("el Dueño y el Administrador nunca quedan bloqueados", () => {
    expect(
      block([item({ unit_price_clp: 1, discount_kind: "percent", discount_value: 9_999 })], {
        override: true,
        cap: 0,
      }),
    ).toBeNull();
  });

  it("con muchos problemas lista los tres primeros y cuenta el resto", () => {
    const bad = item({ unit_price_clp: 5, gross_clp: 5 });
    const message = block([bad, bad, bad, bad, bad])!;
    expect(message).toContain("La línea 1");
    expect(message).toContain("La línea 3");
    expect(message).not.toContain("La línea 4");
    expect(message.endsWith("Hay 2 problemas más.")).toBe(true);
  });
});

describe("el error de la base al enviar", () => {
  it("lee la lista y habla de cada línea", () => {
    expect(lineRulesPrepareError("line_rules_invalid: price_locked@1")).toBe(
      "La línea 2 tiene un precio bloqueado distinto al precio con que se agregó. Vuelve a la cotización y usa ese precio.",
    );
    expect(
      lineRulesPrepareError("line_rules_invalid: discount_over_cap@0,global_discount_over_cap"),
    ).toBe(
      "El descuento de la línea 1 pasa del máximo que permite tu organización. El descuento general pasa del máximo que permite tu organización.",
    );
  });

  it("un código que esta versión no conoce cae en el mensaje general", () => {
    expect(lineRulesPrepareError("line_rules_invalid: algo_nuevo@2")).toBe(
      LINE_RULES_GENERIC_MESSAGE,
    );
    expect(lineRulesPrepareError("line_rules_invalid:")).toBeTruthy();
  });

  it("un error de otra cosa no es de esta regla", () => {
    expect(lineRulesPrepareError("approval_required")).toBeNull();
  });
});
