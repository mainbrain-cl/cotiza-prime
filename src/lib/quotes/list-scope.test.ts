import { describe, expect, it } from "vitest";
import { parseQuoteScope, quoteListHref } from "./list-scope";

describe("filtro de la lista de cotizaciones", () => {
  it("'mias' filtra las propias y todo lo demás muestra todas", () => {
    expect(parseQuoteScope("mias")).toBe("mine");
    expect(parseQuoteScope(["mias", "todas"])).toBe("mine");
    expect(parseQuoteScope(undefined)).toBe("all");
    expect(parseQuoteScope("todas")).toBe("all");
    expect(parseQuoteScope("MIAS")).toBe("all");
    expect(parseQuoteScope("")).toBe("all");
  });

  it("arma la dirección de cada filtro", () => {
    expect(quoteListHref("/o/abc/cotizaciones", "all")).toBe("/o/abc/cotizaciones");
    expect(quoteListHref("/o/abc/cotizaciones", "mine")).toBe("/o/abc/cotizaciones?ver=mias");
  });
});
