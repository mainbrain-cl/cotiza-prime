// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ErrorScreen } from "./error-screen";

let host: HTMLDivElement;
let root: Root;
const retry = vi.fn();

beforeEach(() => {
  retry.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function show(error: unknown) {
  await act(async () => root.render(createElement(ErrorScreen, { error, retry })));
}

describe("ErrorScreen", () => {
  it("un fallo de red dice que no se pudo conectar y qué revisar", async () => {
    await show(new TypeError("Failed to fetch"));
    expect(host.querySelector("h1")?.textContent).toBe("No pudimos conectarnos");
    expect(host.textContent).toContain("Revisa tu conexión a internet");
  });

  it("cualquier otro error da el mensaje general, sin detalle técnico", async () => {
    await show(new Error("An error occurred in the Server Components render. digest 123"));
    expect(host.querySelector("h1")?.textContent).toBe("Algo salió mal");
    expect(host.textContent).not.toContain("Server Components");
    expect(host.textContent).not.toContain("digest");
  });

  it("es un aviso para lectores de pantalla y «Reintentar» llama a retry", async () => {
    await show(new Error("x"));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Reintentar",
    )!;
    await act(async () => button.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
