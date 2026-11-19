import { describe, expect, it } from "vitest";
import { isNetworkError } from "./network-error";

describe("isNetworkError", () => {
  it.each([
    "Failed to fetch",
    "Load failed",
    "NetworkError when attempting to fetch resource.",
    "network error",
    "Network request failed",
    "The network connection was lost.",
  ])("reconoce el mensaje del navegador: %s", (message) => {
    expect(isNetworkError(new TypeError(message))).toBe(true);
  });

  it("reconoce que no se pudo descargar un trozo de código de la aplicación", () => {
    const error = new Error("Failed to load chunk /_next/static/chunks/abc.js from module 23771");
    error.name = "ChunkLoadError";
    expect(isNetworkError(error)).toBe(true);
  });

  it("no confunde un error del servidor ni un valor que no es Error", () => {
    expect(isNetworkError(new Error("An error occurred in the Server Components render."))).toBe(
      false,
    );
    expect(isNetworkError("Failed to fetch")).toBe(false);
    // Un `Error` común con ese texto (no `TypeError`) no es de red, ni una frase que solo lo contiene.
    expect(isNetworkError(new Error("Failed to fetch"))).toBe(false);
    expect(isNetworkError(new TypeError("Pedido: load failed por falta de stock"))).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});
