// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ signUpAction: vi.fn() }));
vi.mock("@/lib/auth/signup-actions", () => ({ signUpAction: mocks.signUpAction }));

import { SignUpForm } from "./signup-form";

let host: HTMLDivElement;
let root: Root;

const text = () => host.textContent ?? "";
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const input = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
async function typeInto(name: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input(name),
      value,
    );
    input(name).dispatchEvent(new Event("input", { bubbles: true }));
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
  mocks.signUpAction.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(SignUpForm, { antibot: { provider: "memory", siteKey: null } }));
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("SignUpForm (paso 1: solo el correo)", () => {
  it("pide solo el correo: ni nombre, ni contraseña, ni casilla de términos", () => {
    expect(input("email")).toBeTruthy();
    expect(input("email").getAttribute("type")).toBe("email");
    expect(input("email").getAttribute("autocomplete")).toBe("email");
    for (const name of ["fullName", "password", "confirmPassword", "acceptLegal"]) {
      expect(host.querySelector(`[name="${name}"]`), name).toBeNull();
    }
    expect(text()).toContain("Enviarme el enlace");
    expect(text()).toContain("Usaremos tu correo solo para enviarte el enlace");
    expect(host.querySelector('a[href="/privacidad"]')).toBeTruthy();
  });

  it("lleva la prueba anti-robot y su token viaja en un campo oculto", async () => {
    expect(byId("antibot-memory")).toBeTruthy();
    expect(input("antibotToken").type).toBe("hidden");
    expect(input("antibotToken").value).toBe("");
    await act(async () => {
      byId("antibot-memory-pass")!.click();
    });
    expect(input("antibotToken").value).toBe("test-pass");
  });

  it("al enviar manda el correo y el token a la acción", async () => {
    mocks.signUpAction.mockResolvedValue({
      status: "sent",
      values: { email: "nueva@ejemplo.test" },
    });
    await typeInto("email", "nueva@ejemplo.test");
    await act(async () => {
      byId("antibot-memory-pass")!.click();
    });
    await submit();
    const sent = mocks.signUpAction.mock.calls[0][1] as FormData;
    expect(sent.get("email")).toBe("nueva@ejemplo.test");
    expect(sent.get("antibotToken")).toBe("test-pass");
  });

  it("tras enviar dice «Revisa tu correo» con el correo, el plazo y a dónde ir si ya tenía cuenta", async () => {
    mocks.signUpAction.mockResolvedValue({
      status: "sent",
      values: { email: "nueva@ejemplo.test" },
    });
    await typeInto("email", "nueva@ejemplo.test");
    await submit();
    expect(byId("signup-sent")).toBeTruthy();
    expect(byId("signup-sent-email")!.textContent).toBe("nueva@ejemplo.test");
    expect(text()).toContain("Revisa tu correo");
    expect(text()).toContain("Ábrelo dentro de una hora");
    expect(text()).toContain(
      "Si ya tenías una cuenta con este correo, ingresa o recupera tu contraseña",
    );
    expect(host.querySelector('a[href="/ingresar"]')).toBeTruthy();
    expect(host.querySelector('a[href="/recuperar-contrasena"]')).toBeTruthy();
    // No promete nada que no exista: ni dice que ya hay cuenta, ni nombra la contraseña elegida.
    expect(text()).not.toContain("Ya tienes cuenta");
  });

  it("desde «Revisa tu correo» se puede pedir otro enlace, y un envío nuevo vuelve a mostrar la confirmación", async () => {
    mocks.signUpAction.mockResolvedValue({
      status: "sent",
      values: { email: "nueva@ejemplo.test" },
    });
    await submit();
    await act(async () => {
      byId("signup-resend")!.click();
    });
    expect(byId("signup-sent")).toBeNull();
    expect(input("email")).toBeTruthy();
    // Otro envío: el resultado es un objeto nuevo y se vuelve a mostrar.
    mocks.signUpAction.mockResolvedValue({
      status: "sent",
      values: { email: "nueva@ejemplo.test" },
    });
    await submit();
    expect(byId("signup-sent")).toBeTruthy();
  });

  it("un error del correo sale junto al campo y uno general, como aviso, conservando lo escrito", async () => {
    mocks.signUpAction.mockResolvedValue({
      status: "error",
      fieldErrors: { email: "Revisa el correo: no parece una dirección válida." },
      values: { email: "mal" },
    });
    await submit();
    expect(text()).toContain("Revisa el correo");
    expect(input("email").value).toBe("mal");
    expect(input("email").getAttribute("aria-invalid")).toBe("true");

    mocks.signUpAction.mockResolvedValue({
      status: "error",
      message: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
      values: { email: "nueva@ejemplo.test" },
    });
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Demasiados intentos");
  });

  it("tras cada envío la prueba anti-robot se vuelve a montar (cada una sirve una sola vez)", async () => {
    mocks.signUpAction.mockResolvedValue({
      status: "error",
      message: "x",
      values: { email: "a@b.test" },
    });
    await act(async () => {
      byId("antibot-memory-pass")!.click();
    });
    expect(byId("antibot-memory-state")!.textContent).toBe("Verificación lista.");
    await submit();
    expect(byId("antibot-memory-state")!.textContent).toBe("Sin verificar.");
    expect(input("antibotToken").value).toBe("");
  });
});
