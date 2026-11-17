import { describe, expect, it } from "vitest";
import {
  MAX_DISCOUNT_TOO_HIGH_MESSAGE,
  describeMaxDiscount,
  maxDiscountHint,
  maxDiscountToText,
  parseMaxDiscountText,
} from "./discount-cap";

describe("leer el descuento máximo que escribe la persona", () => {
  it.each([
    ["", null],
    ["   ", null],
    ["0", 0],
    ["10", 1_000],
    ["10 %", 1_000],
    ["12,5", 1_250],
    ["99,99", 9_999],
  ])("%j -> %j", (text, value) => {
    expect(parseMaxDiscountText(text)).toEqual({ ok: true, value });
  });

  it.each(["100", "100,00", "99,999", "-5", "abc", "1,2,3", "10.5"])("rechaza %j", (text) => {
    const result = parseMaxDiscountText(text);
    expect(result.ok).toBe(false);
  });

  it("100 % dice que debe ser menor que 100 %", () => {
    expect(parseMaxDiscountText("100")).toEqual({
      ok: false,
      message: MAX_DISCOUNT_TOO_HIGH_MESSAGE,
    });
  });
});

describe("el texto del campo", () => {
  it.each([
    [null, ""],
    [0, "0"],
    [1_000, "10"],
    [1_250, "12,5"],
    [9_999, "99,99"],
  ])("%j se escribe %j", (bp, text) => {
    expect(maxDiscountToText(bp)).toBe(text);
    expect(parseMaxDiscountText(maxDiscountToText(bp))).toEqual({ ok: true, value: bp });
  });
});

describe("las frases", () => {
  it("la frase en vivo dice «sin tope», «ningún descuento» o el máximo", () => {
    expect(describeMaxDiscount(null)).toBe(
      "Sin tope: los Comerciales pueden dar el descuento que quieran.",
    );
    expect(describeMaxDiscount(0)).toBe("Los Comerciales no podrán dar ningún descuento.");
    expect(describeMaxDiscount(1_250)).toBe(
      "Los Comerciales podrán dar hasta 12,5 % de descuento, en cada línea y en el descuento general.",
    );
  });

  it("junto a cada descuento del editor", () => {
    expect(maxDiscountHint(null)).toBeNull();
    expect(maxDiscountHint(1_000)).toBe("Máximo 10 %");
    expect(maxDiscountHint(0)).toBe("Tu organización no permite descuentos");
  });
});
