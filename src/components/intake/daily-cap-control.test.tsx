// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  saveDailyCapAction: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("@/lib/intake/builder-actions", () => ({ saveDailyCapAction: mocks.saveDailyCapAction }));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }));

import { DailyCapControl } from "./daily-cap-control";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const FORM_ID = "AAAAAAAAAAAAAAAAAAAAAA";

let host: HTMLDivElement;
let root: Root;

const input = () => host.querySelector<HTMLInputElement>('[data-testid="daily-cap-input"]')!;
const saveButton = () => host.querySelector<HTMLButtonElement>('[data-testid="daily-cap-save"]')!;
const form = () => host.querySelector<HTMLFormElement>('[data-testid="daily-cap-form"]')!;

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

beforeEach(() => {
  mocks.saveDailyCapAction.mockReset();
  mocks.toastSuccess.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount() {
  await act(async () => {
    root.render(
      createElement(DailyCapControl, {
        tenantId: TENANT_ID,
        formId: FORM_ID,
        initialCap: 50,
        editable: true,
      }),
    );
  });
}

describe("DailyCapControl (H-092): lo que se escribe mientras se guarda", () => {
  it("si se escribe otro número mientras guarda, la respuesta del servidor no lo pisa", async () => {
    let resolveSave!: (value: unknown) => void;
    mocks.saveDailyCapAction.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    await mount();

    await type("200");
    await submit();
    expect(saveButton().textContent).toBe("Guardando…");

    await type("1");
    await act(async () => {
      resolveSave({
        status: "ok",
        message: "Guardamos el tope: 200 solicitudes por día.",
        dailyCap: 200,
      });
    });

    expect(input().value).toBe("1");
    expect(saveButton().textContent).toBe("Guardar tope");
    expect(saveButton().disabled).toBe(false);
  });

  it("si no se escribió nada más, el campo queda con el valor guardado y sin cambios pendientes", async () => {
    mocks.saveDailyCapAction.mockResolvedValueOnce({
      status: "ok",
      message: "Guardamos el tope: 200 solicitudes por día.",
      dailyCap: 200,
    });
    await mount();

    await type("200");
    await submit();

    expect(mocks.saveDailyCapAction).toHaveBeenCalledWith(TENANT_ID, FORM_ID, 200);
    expect(input().value).toBe("200");
    expect(saveButton().disabled).toBe(true);
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });
});
