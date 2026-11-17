// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  saveDiscountCapAction: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("@/lib/catalog/discount-cap-actions", () => ({
  saveDiscountCapAction: mocks.saveDiscountCapAction,
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }));

import { DiscountCapForm } from "./discount-cap-form";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

let host: HTMLDivElement;
let root: Root;

const input = () => host.querySelector<HTMLInputElement>('[data-testid="discount-cap-input"]')!;
const saveButton = () => host.querySelector<HTMLButtonElement>('[data-testid="discount-cap-save"]');
const preview = () => host.querySelector('[data-testid="discount-cap-preview"]')!.textContent;
const form = () => host.querySelector<HTMLFormElement>('[data-testid="discount-cap-form"]')!;
const banner = () => host.querySelector('[data-testid="discount-cap-banner"]');

async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function mount(props: { initialBp: number | null; editable: boolean }) {
  await act(async () => {
    root.render(createElement(DiscountCapForm, { tenantId: TENANT_ID, ...props }));
  });
}

beforeEach(() => {
  mocks.saveDiscountCapAction.mockReset();
  mocks.toastSuccess.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("DiscountCapForm (H-041)", () => {
  it("parte con el valor guardado, la frase en vivo y el botón apagado (nada que guardar)", async () => {
    await mount({ initialBp: 1_000, editable: true });
    expect(input().value).toBe("10");
    expect(preview()).toBe(
      "Los Comerciales podrán dar hasta 10 % de descuento, en cada línea y en el descuento general.",
    );
    expect(saveButton()!.disabled).toBe(true);
  });

  it("vacío es «Sin tope» y la frase cambia mientras se escribe", async () => {
    await mount({ initialBp: null, editable: true });
    expect(input().value).toBe("");
    expect(preview()).toBe("Sin tope: los Comerciales pueden dar el descuento que quieran.");
    await type("0");
    expect(preview()).toBe("Los Comerciales no podrán dar ningún descuento.");
    await type("12,5");
    expect(preview()).toMatch(/hasta 12,5 %/);
    expect(saveButton()!.disabled).toBe(false);
  });

  it("guarda el valor ya leído (en centésimas de punto) y avisa", async () => {
    mocks.saveDiscountCapAction.mockResolvedValueOnce({
      status: "ok",
      message: "Guardamos el descuento máximo de los Comerciales.",
      maxDiscountBp: 1_000,
    });
    await mount({ initialBp: null, editable: true });
    await type("10");
    await submit();
    expect(mocks.saveDiscountCapAction).toHaveBeenCalledWith(TENANT_ID, 1_000);
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(saveButton()!.disabled).toBe(true);
    expect(input().value).toBe("10");
  });

  it("mientras guarda dice «Guardando…»", async () => {
    let resolveSave!: (value: unknown) => void;
    mocks.saveDiscountCapAction.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    await mount({ initialBp: null, editable: true });
    await type("10");
    await submit();
    expect(saveButton()!.textContent).toBe("Guardando…");
    expect(saveButton()!.disabled).toBe(true);
    await act(async () => {
      resolveSave({ status: "ok", message: "ok", maxDiscountBp: 1_000 });
    });
    expect(saveButton()!.textContent).toBe("Guardar descuento máximo");
  });

  it("un valor que no sirve da el error en el campo y no llama a la acción", async () => {
    await mount({ initialBp: null, editable: true });
    await type("100");
    await submit();
    expect(mocks.saveDiscountCapAction).not.toHaveBeenCalled();
    expect(host.textContent).toContain("El máximo debe ser menor que 100 %");
    expect(input().getAttribute("aria-invalid")).toBe("true");
  });

  it("si la acción responde con un error, lo muestra arriba y deja lo escrito", async () => {
    mocks.saveDiscountCapAction.mockResolvedValueOnce({
      status: "error",
      message: "No tienes permiso para esto.",
    });
    await mount({ initialBp: null, editable: true });
    await type("10");
    await submit();
    expect(banner()!.textContent).toContain("No tienes permiso para esto.");
    expect(input().value).toBe("10");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("sin conexión (la llamada falla) lo dice y conserva lo escrito", async () => {
    mocks.saveDiscountCapAction.mockRejectedValueOnce(new Error("Failed to fetch"));
    await mount({ initialBp: null, editable: true });
    await type("10");
    await submit();
    expect(banner()!.textContent).toMatch(/Revisa tu conexión/);
    expect(input().value).toBe("10");
    expect(saveButton()!.disabled).toBe(false);
  });

  it("si se escribe otro valor mientras guarda, la respuesta no lo pisa", async () => {
    let resolveSave!: (value: unknown) => void;
    mocks.saveDiscountCapAction.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    await mount({ initialBp: null, editable: true });
    await type("10");
    await submit();
    await type("5");
    await act(async () => {
      resolveSave({ status: "ok", message: "ok", maxDiscountBp: 1_000 });
    });
    expect(input().value).toBe("5");
    expect(saveButton()!.disabled).toBe(false);
  });

  it("quien no maneja el catálogo lo ve en solo lectura: campo apagado y sin botón", async () => {
    await mount({ initialBp: 1_000, editable: false });
    expect(input().disabled).toBe(true);
    expect(saveButton()).toBeNull();
    expect(host.querySelector('[data-testid="discount-cap-readonly"]')).not.toBeNull();
    await submit();
    expect(mocks.saveDiscountCapAction).not.toHaveBeenCalled();
  });
});
