// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SilentBoundary } from "./silent-boundary";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // React escribe en consola el error que atrapa el límite; aquí es esperado.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function Boom(): never {
  throw new Error("no se pudo descargar");
}

describe("SilentBoundary", () => {
  it("si el adorno falla, no dibuja nada y el resto de la pantalla sigue", async () => {
    await act(async () => {
      root.render(
        createElement(
          "main",
          null,
          createElement("p", null, "Ingresa a tu cuenta"),
          createElement(SilentBoundary, null, createElement(Boom)),
        ),
      );
    });
    expect(host.textContent).toBe("Ingresa a tu cuenta");
  });

  it("deja un aviso en la consola, sin tragarse el error en silencio", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => {
      root.render(createElement(SilentBoundary, null, createElement(Boom)));
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(" ")).toContain("no se pudo descargar");
  });

  it("si no falla, muestra el contenido", async () => {
    await act(async () => {
      root.render(createElement(SilentBoundary, null, createElement("span", null, "fondo")));
    });
    expect(host.textContent).toBe("fondo");
  });
});
