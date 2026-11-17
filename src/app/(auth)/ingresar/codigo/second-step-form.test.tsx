// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  verifySecondStepAction: vi.fn(),
  verifyRecoveryCodeAction: vi.fn(),
}));
vi.mock("@/lib/auth/second-step-actions", () => ({
  verifySecondStepAction: mocks.verifySecondStepAction,
}));
vi.mock("@/lib/auth/recovery-code-actions", () => ({
  verifyRecoveryCodeAction: mocks.verifyRecoveryCodeAction,
}));

import { SecondStepForm } from "./second-step-form";

let host: HTMLDivElement;
let root: Root;

const text = () => host.textContent ?? "";
const input = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
const buttonByText = (label: string) =>
  [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(label))!;
async function click(label: string) {
  await act(async () => {
    buttonByText(label).click();
  });
}
async function typeInto(name: string, value: string) {
  const field = input(name)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(SecondStepForm));
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("SecondStepForm: el código de la aplicación y el de respaldo", () => {
  it("al abrirse pide el código de 6 números y ofrece el de respaldo; no muestra su campo", () => {
    expect(input("code")).toBeTruthy();
    expect(input("recoveryCode")).toBeNull();
    expect(text()).toContain("¿No tienes tu teléfono? Usa un código de respaldo");
  });

  it("al elegir el de respaldo cambia el formulario: campo propio con los atributos correctos y el aviso de que desactiva la verificación", async () => {
    await click("¿No tienes tu teléfono? Usa un código de respaldo");
    expect(input("code")).toBeNull();
    const field = input("recoveryCode")!;
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("autocapitalize")).toBe("characters");
    expect(field.getAttribute("spellcheck")).toBe("false");
    expect(field.getAttribute("type")).toBe("text");
    expect(field.hasAttribute("maxlength")).toBe(false);
    expect(text()).toContain("Código de respaldo");
    expect(text()).toContain(
      "Al usarlo, la verificación en dos pasos se desactiva y tendrás que activarla de nuevo con tu teléfono.",
    );
    expect(buttonByText("Entrar con el código de respaldo")).toBeTruthy();
  });

  it("se puede volver al código de la aplicación", async () => {
    await click("¿No tienes tu teléfono? Usa un código de respaldo");
    await click("Volver al código de mi aplicación");
    expect(input("code")).toBeTruthy();
    expect(input("recoveryCode")).toBeNull();
  });

  it("el código de respaldo se envía a SU acción (no a la de la aplicación) y un error se muestra, con el campo vacío y el foco en él", async () => {
    mocks.verifyRecoveryCodeAction.mockResolvedValue({
      status: "error",
      message:
        "Ese código de respaldo no sirve. Revisa cómo lo escribiste; cada código sirve una sola vez.",
    });
    await click("¿No tienes tu teléfono? Usa un código de respaldo");
    await typeInto("recoveryCode", "7KQM-3XHP-W2RT");
    await submit();
    expect(mocks.verifyRecoveryCodeAction).toHaveBeenCalledTimes(1);
    expect(mocks.verifySecondStepAction).not.toHaveBeenCalled();
    const sent = mocks.verifyRecoveryCodeAction.mock.calls[0][1] as FormData;
    expect(sent.get("recoveryCode")).toBe("7KQM-3XHP-W2RT");
    expect(text()).toContain("Ese código de respaldo no sirve.");
    // Tras un error el foco vuelve al campo.
    expect(document.activeElement).toBe(input("recoveryCode"));
  });

  it("un error de forma (6 números) sale en el campo, junto a él", async () => {
    mocks.verifyRecoveryCodeAction.mockResolvedValue({
      status: "error",
      fieldErrors: {
        recoveryCode:
          "Eso parece el código de tu aplicación. Aquí va un código de respaldo de 12 letras y números.",
      },
    });
    await click("¿No tienes tu teléfono? Usa un código de respaldo");
    await typeInto("recoveryCode", "123456");
    await submit();
    expect(text()).toContain("Eso parece el código de tu aplicación.");
    expect(input("recoveryCode")?.getAttribute("aria-invalid")).toBe("true");
  });
});
