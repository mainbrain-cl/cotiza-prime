import { describe, expect, it } from "vitest";
import {
  LOCKED_PRICE_TEXT,
  describeLockedPriceChanges,
  describeLockedPriceOverride,
} from "./locked-price-text";

const change = (position: number, oldPrice: number | null, newPrice: number) => ({
  position,
  catalog_item_id: "11111111-1111-4111-8111-111111111111",
  old_price_clp: oldPrice,
  new_price_clp: newPrice,
});

describe("el cambio de un precio bloqueado, en palabras", () => {
  it("una línea: «línea 2: $10.000 → $8.000»", () => {
    expect(describeLockedPriceOverride({ count: 1, lines: [change(2, 10_000, 8_000)] })).toBe(
      "Se cambió un precio bloqueado (línea 2: $10.000 → $8.000)",
    );
  });

  it("varias líneas se cuentan juntas", () => {
    expect(
      describeLockedPriceOverride({
        count: 2,
        lines: [change(1, 5_000, 4_000), change(3, 20_000, 25_000)],
      }),
    ).toBe(
      "Se cambiaron 2 precios bloqueados (línea 1: $5.000 → $4.000; línea 3: $20.000 → $25.000)",
    );
  });

  it("una línea nueva (sin precio anterior) dice a cuánto se agregó", () => {
    expect(describeLockedPriceChanges({ count: 1, lines: [change(4, null, 7_000)] })).toBe(
      "línea 4: agregada a $7.000",
    );
  });

  it("si el registro no trae todas las líneas, dice cuántas más hubo", () => {
    expect(
      describeLockedPriceChanges({ count: 25, lines: [change(1, 1, 2), change(2, 3, 4)] }),
    ).toBe("línea 1: $1 → $2; línea 2: $3 → $4; y 23 más");
    expect(
      describeLockedPriceChanges({ count: 3, lines: [change(1, 1, 2), change(2, 3, 4)] }),
    ).toMatch(/; y 1 más$/);
  });

  it.each([null, undefined, 3, "x", {}, { count: 1 }, { count: 1, lines: "x" }, { lines: [] }])(
    "datos ilegibles (%j) no rompen la pantalla",
    (data) => {
      expect(describeLockedPriceOverride(data)).toBe(LOCKED_PRICE_TEXT);
      expect(describeLockedPriceChanges(data)).toBeNull();
    },
  );

  it.each([
    { count: 1, lines: [{ position: 0, old_price_clp: 1, new_price_clp: 2 }] },
    { count: 1, lines: [{ position: 1, old_price_clp: -1, new_price_clp: 2 }] },
    { count: 1, lines: [{ position: 1, old_price_clp: 1, new_price_clp: "2" }] },
    { count: 1, lines: [null] },
  ])("una línea mal formada (%j) deja el texto general", (data) => {
    expect(describeLockedPriceOverride(data)).toBe(LOCKED_PRICE_TEXT);
  });
});
