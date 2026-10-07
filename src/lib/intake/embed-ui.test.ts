import { describe, expect, it } from "vitest";
import {
  EmbedError,
  buildResizeMessage,
  buildScrollMessage,
  embedFrameAncestors,
  embedOriginProblem,
  isValidEmbedOrigin,
} from "./embed";

describe("embedFrameAncestors", () => {
  it("devuelve 'none' o la lista sin repetidos, y falla con texto dudoso", () => {
    expect(embedFrameAncestors([])).toBe("'none'");
    expect(embedFrameAncestors(["https://a.cl", "https://a.cl", "https://b.cl"])).toBe(
      "https://a.cl https://b.cl",
    );
    expect(() => embedFrameAncestors(["*"])).toThrow(EmbedError);
  });
});

describe("buildResizeMessage", () => {
  it("lleva solo source, type y height (entero acotado)", () => {
    expect(buildResizeMessage(640.2)).toEqual({
      source: "cotiza-prime",
      type: "resize",
      height: 641,
    });
    expect(Object.keys(buildResizeMessage(100)!).sort()).toEqual(["height", "source", "type"]);
    expect(buildResizeMessage(99_999)!.height).toBe(4_000);
    expect(buildResizeMessage(Number.NaN)).toBeNull();
    expect(buildResizeMessage(Number.POSITIVE_INFINITY)).toBeNull();
    expect(buildResizeMessage(-5)).toBeNull();
  });
});

describe("buildScrollMessage", () => {
  it("lleva solo source y type: ningún dato", () => {
    expect(buildScrollMessage()).toEqual({ source: "cotiza-prime", type: "scroll" });
    expect(Object.keys(buildScrollMessage()).sort()).toEqual(["source", "type"]);
  });
});

describe("embedOriginProblem", () => {
  it("los dominios con ñ o tildes explican la forma xn-- y la versión con y sin www", () => {
    for (const value of ["https://diseño.cl", "https://www.café.cl", "https://ÑANDÚ.cl"]) {
      const problem = embedOriginProblem(value);
      expect(problem, value).toMatch(/xn--/);
      expect(problem, value).toMatch(/con y sin www/);
    }
    expect(embedOriginProblem("https://xn--diseo-0qa.cl")).toBeNull();
  });

  it("explica cada rechazo y acepta lo válido", () => {
    expect(embedOriginProblem("https://www.sitio.cl")).toBeNull();
    expect(embedOriginProblem("")).toMatch(/Escribe/);
    expect(embedOriginProblem("http://sitio.cl")).toMatch(/https:\/\//);
    expect(embedOriginProblem("https://*.sitio.cl")).toMatch(/comodines/);
    expect(embedOriginProblem("https://sitio.cl; script-src *")).toMatch(/espacios|signos/);
    expect(embedOriginProblem("https://sitio.cl/ruta")).toMatch(/ruta/);
    expect(embedOriginProblem("https://sitio.cl/")).toMatch(/ruta|barra/);
    expect(embedOriginProblem("https://SITIO.cl")).toMatch(/minúsculas/);
    expect(embedOriginProblem("sitio.cl")).toMatch(/https:\/\//);
  });

  it("coincide con la regla real: lo que la pantalla acepta también lo acepta isValidEmbedOrigin", () => {
    for (const value of [
      "https://a.cl",
      "https://x.cl:8443",
      "https://SITIO.cl",
      "https://a",
      "*",
      "https://a.cl\n",
      "https://a.cl:0",
      "http://a.cl",
    ]) {
      expect(embedOriginProblem(value) === null, value).toBe(isValidEmbedOrigin(value));
    }
  });
});
