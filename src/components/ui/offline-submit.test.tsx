// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

import { SubmitButton } from "./form-controls";
import { blockIfOffline, OFFLINE_MESSAGE } from "./offline-notice";

let host: HTMLDivElement;
let root: Root;
let online: boolean;
const onSubmit = vi.fn((event: Event) => event.preventDefault());

function setOnline(value: boolean) {
  online = value;
}

beforeEach(() => {
  mocks.toastError.mockReset();
  onSubmit.mockClear();
  online = true;
  vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => online);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function renderForm(onClick?: (event: { preventDefault: () => void }) => void) {
  await act(async () => {
    root.render(
      createElement(
        "form",
        { onSubmit: (event) => onSubmit(event.nativeEvent) },
        createElement("input", { name: "campo", defaultValue: "algo escrito" }),
        createElement(SubmitButton, { pendingLabel: "Enviando…", onClick }, "Enviar"),
      ),
    );
  });
  return host.querySelector<HTMLButtonElement>("button")!;
}

describe("enviar sin conexión", () => {
  it("con red, el botón envía el formulario y no avisa nada", async () => {
    const button = await renderForm();
    await act(async () => button.click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("sin red, no envía, avisa en cada intento con un identificador fijo (Sonner no apila avisos iguales) y lo escrito sigue ahí", async () => {
    const button = await renderForm();
    setOnline(false);
    await act(async () => button.click());
    await act(async () => button.click());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledTimes(2);
    expect(mocks.toastError).toHaveBeenCalledWith(OFFLINE_MESSAGE, { id: "offline-submit" });
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("algo escrito");
  });

  it("al volver la red, el mismo botón envía", async () => {
    const button = await renderForm();
    setOnline(false);
    await act(async () => button.click());
    setOnline(true);
    await act(async () => button.click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("si quien usa el botón ya frenó el clic, no se avisa de red", async () => {
    const button = await renderForm((event) => event.preventDefault());
    setOnline(false);
    await act(async () => button.click());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});

describe("blockIfOffline", () => {
  it("devuelve false con red y true sin ella, y frena el evento solo sin red", () => {
    const event = { preventDefault: vi.fn() };
    expect(blockIfOffline(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    setOnline(false);
    expect(blockIfOffline(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});
