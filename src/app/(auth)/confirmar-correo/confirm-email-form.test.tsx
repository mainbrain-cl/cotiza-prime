// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ confirmEmailLinkAction: vi.fn() }));
vi.mock("@/lib/auth/signup-actions", () => ({
  confirmEmailLinkAction: mocks.confirmEmailLinkAction,
}));

import { ConfirmEmailForm } from "./confirm-email-form";

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? "";
async function submit() {
  await act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  mocks.confirmEmailLinkAction.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(ConfirmEmailForm, { tokenHash: "abc123_-XYZ" }));
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("ConfirmEmailForm (el clic que canjea el enlace)", () => {
  it("al abrirse solo muestra «Continuar»: no llama a la acción", () => {
    expect(host.querySelector("button")!.textContent).toContain("Continuar");
    expect(mocks.confirmEmailLinkAction).not.toHaveBeenCalled();
  });

  it("el clic manda el código del enlace en un campo oculto", async () => {
    mocks.confirmEmailLinkAction.mockResolvedValue({ status: "idle" });
    await submit();
    expect(mocks.confirmEmailLinkAction).toHaveBeenCalledTimes(1);
    const sent = mocks.confirmEmailLinkAction.mock.calls[0][1] as FormData;
    expect(sent.get("token_hash")).toBe("abc123_-XYZ");
  });

  it("si el enlace ya no sirve, lo dice y ofrece pedir uno nuevo (sin volver a mostrar «Continuar»)", async () => {
    mocks.confirmEmailLinkAction.mockResolvedValue({ status: "error", expired: true });
    await submit();
    expect(text()).toContain("Este enlace ya se usó o venció");
    expect(host.querySelector('a[href="/registro"]')!.textContent).toContain(
      "Pedir un enlace nuevo",
    );
    expect(host.querySelector("form")).toBeNull();
  });

  it("si falló otra cosa, lo dice y deja reintentar con el mismo enlace", async () => {
    mocks.confirmEmailLinkAction.mockResolvedValue({
      status: "error",
      message:
        "No pudimos confirmar tu correo en este momento. Inténtalo de nuevo en unos minutos.",
    });
    await submit();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(
      "No pudimos confirmar tu correo",
    );
    expect(host.querySelector("form")).toBeTruthy();
    expect(host.querySelector<HTMLInputElement>('input[name="token_hash"]')!.value).toBe(
      "abc123_-XYZ",
    );
  });
});
