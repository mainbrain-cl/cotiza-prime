// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ completeAccountSetupAction: vi.fn(), signOutAction: vi.fn() }));
vi.mock("@/lib/auth/signup-actions", () => ({
  completeAccountSetupAction: mocks.completeAccountSetupAction,
}));
vi.mock("@/lib/auth/actions", () => ({ signOutAction: mocks.signOutAction }));

import { CreateAccountForm } from "./create-account-form";

let host: HTMLDivElement;
let root: Root;

const text = () => host.textContent ?? "";
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const input = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
async function submit() {
  await act(async () => {
    [...host.querySelectorAll("form")]
      .find((form) => form.querySelector('input[name="fullName"]'))!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(CreateAccountForm, {
        email: "nueva@ejemplo.test",
        termsVersion: "2026-10-01-preliminar",
        privacyVersion: "2026-10-01-preliminar",
      }),
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("CreateAccountForm (paso 2: nombre, contraseña y términos)", () => {
  it("muestra el correo en un recuadro destacado con la salida «¿No es tu correo? Salir»", () => {
    expect(byId("create-account-email-box")).toBeTruthy();
    expect(text()).toContain("Estás creando la cuenta de");
    expect(byId("create-account-email")!.textContent).toBe("nueva@ejemplo.test");
    expect(byId("create-account-leave")!.textContent).toContain("¿No es tu correo? Salir");
    expect(byId("create-account-leave")!.getAttribute("type")).toBe("submit");
  });

  it("pide nombre, contraseña dos veces y la casilla de términos y privacidad, con los atributos correctos", () => {
    expect(input("fullName").getAttribute("autocomplete")).toBe("name");
    for (const name of ["password", "confirmPassword"]) {
      expect(input(name).getAttribute("type"), name).toBe("password");
      expect(input(name).getAttribute("autocomplete"), name).toBe("new-password");
    }
    expect(input("acceptLegal").getAttribute("type")).toBe("checkbox");
    expect(host.querySelector('a[href="/terminos"]')).toBeTruthy();
    expect(host.querySelector('a[href="/privacidad"]')).toBeTruthy();
    expect(text()).toContain("Mínimo 10 caracteres.");
    expect(text()).toContain("Crear mi cuenta");
  });

  it("las versiones de los documentos que se mostraron viajan ocultas", () => {
    expect(input("termsVersion").type).toBe("hidden");
    expect(input("termsVersion").value).toBe("2026-10-01-preliminar");
    expect(input("privacyVersion").value).toBe("2026-10-01-preliminar");
  });

  it("la casilla «Mostrar las contraseñas» muestra u oculta las dos y no se envía con el formulario", async () => {
    const toggle = byId("show-passwords") as HTMLInputElement;
    expect(toggle.hasAttribute("name")).toBe(false);
    await act(async () => {
      toggle.click();
    });
    expect(input("password").type).toBe("text");
    expect(input("confirmPassword").type).toBe("text");
    await act(async () => {
      toggle.click();
    });
    expect(input("password").type).toBe("password");
  });

  it("al enviar manda todo a la acción", async () => {
    mocks.completeAccountSetupAction.mockResolvedValue({ status: "idle" });
    await submit();
    expect(mocks.completeAccountSetupAction).toHaveBeenCalledTimes(1);
    const sent = mocks.completeAccountSetupAction.mock.calls[0][1] as FormData;
    expect([...sent.keys()].sort()).toEqual(
      ["confirmPassword", "fullName", "password", "privacyVersion", "termsVersion"].sort(),
    );
  });

  it("un error de un campo sale junto al campo y conserva el nombre escrito (nunca la contraseña)", async () => {
    mocks.completeAccountSetupAction.mockResolvedValue({
      status: "error",
      fieldErrors: { confirmPassword: "Las contraseñas no coinciden." },
      values: { fullName: "Ana Pérez" },
    });
    await submit();
    expect(text()).toContain("Las contraseñas no coinciden.");
    expect(input("confirmPassword").getAttribute("aria-invalid")).toBe("true");
    expect(input("fullName").value).toBe("Ana Pérez");
    expect(input("password").value).toBe("");
  });

  it("tras un error la casilla de términos conserva lo que la persona había marcado", async () => {
    mocks.completeAccountSetupAction.mockResolvedValue({
      status: "error",
      fieldErrors: { confirmPassword: "Las contraseñas no coinciden." },
      values: { fullName: "Ana", acceptLegal: "on" },
    });
    await submit();
    expect(input("acceptLegal").checked).toBe(true);
    mocks.completeAccountSetupAction.mockResolvedValue({
      status: "error",
      message: "Actualizamos los términos o la política de privacidad.",
      values: { fullName: "Ana" },
    });
    await submit();
    expect(input("acceptLegal").checked).toBe(false);
  });

  it("un error general sale como aviso arriba del formulario", async () => {
    mocks.completeAccountSetupAction.mockResolvedValue({
      status: "error",
      message:
        "Actualizamos los términos o la política de privacidad mientras llenabas el formulario.",
      values: { fullName: "Ana" },
    });
    await submit();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(
      "Actualizamos los términos",
    );
    expect(host.querySelector("form input[name='fullName']")).toBeTruthy();
  });

  it("si el enlace venció, la pantalla lo dice y ofrece pedir uno nuevo en vez de reintentar", async () => {
    mocks.completeAccountSetupAction.mockResolvedValue({
      status: "error",
      message: "Tu enlace venció o ya se usó. Pide uno nuevo para terminar tu cuenta.",
      expired: true,
    });
    await submit();
    expect(byId("create-account-expired")).toBeTruthy();
    expect(text()).toContain("Tu enlace venció");
    expect(host.querySelector('a[href="/registro"]')!.textContent).toContain(
      "Pedir un enlace nuevo",
    );
    expect(host.querySelector('input[name="password"]')).toBeNull();
  });
});
