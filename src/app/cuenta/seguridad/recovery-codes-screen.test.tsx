// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ acknowledgeRecoveryCodesAction: vi.fn() }));
vi.mock("@/lib/auth/recovery-code-actions", () => ({
  acknowledgeRecoveryCodesAction: mocks.acknowledgeRecoveryCodesAction,
}));

import { RecoveryCodesScreen } from "./recovery-codes-screen";

const SET_ID = "33333333-3333-4333-8333-333333333333";
const CODES = [
  "7KQM-3XHP-W2RT",
  "AAAA-BBBB-CCCC",
  "DDDD-EEEE-FFFF",
  "GGGG-HHHH-JJJJ",
  "KKKK-MMMM-NNNN",
  "PPPP-QQQQ-RRRR",
  "SSSS-TTTT-VVVV",
  "WWWW-XXXX-YYYY",
  "ZZZZ-0000-1111",
  "2222-3333-4444",
];

let host: HTMLDivElement;
let root: Root;
const onDone = vi.fn();

const buttonByText = (text: string) =>
  [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(text))!;
const checkbox = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

beforeEach(async () => {
  mocks.acknowledgeRecoveryCodesAction.mockReset();
  onDone.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(RecoveryCodesScreen, { codes: CODES, setId: SET_ID, onDone }));
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("RecoveryCodesScreen (Tus códigos de respaldo)", () => {
  it("muestra los 10 códigos numerados, en una fuente de ancho fijo y con el texto de «solo los verás esta vez»", () => {
    const shown = [...host.querySelectorAll('[data-testid="recovery-code"]')];
    expect(shown.map((node) => node.textContent)).toEqual(CODES);
    expect(shown.every((node) => node.className.includes("font-mono"))).toBe(true);
    expect(host.querySelectorAll("ol > li")).toHaveLength(10);
    const text = host.textContent ?? "";
    expect(text).toContain("Tus códigos de respaldo");
    expect(text).toContain(
      "Solo los verás esta vez. Cada código sirve una sola vez. Si pierdes tu teléfono, entra con uno.",
    );
  });

  it("no cabe desplazamiento horizontal: una columna en teléfono y los códigos no se cortan", () => {
    const list = host.querySelector("ol")!;
    expect(list.className).toContain("grid-cols-1");
    expect(list.className).not.toContain("overflow-x");
  });

  it("«Listo» está deshabilitado hasta marcar la casilla «Guardé estos códigos en un lugar seguro»", async () => {
    expect(host.textContent).toContain("Guardé estos códigos en un lugar seguro");
    expect(buttonByText("Listo").disabled).toBe(true);
    await act(async () => {
      checkbox().click();
    });
    expect(buttonByText("Listo").disabled).toBe(false);
    await act(async () => {
      checkbox().click();
    });
    expect(buttonByText("Listo").disabled).toBe(true);
  });

  it("«Listo» confirma el juego (por su identificador) y recién entonces termina", async () => {
    mocks.acknowledgeRecoveryCodesAction.mockResolvedValue({ status: "ok" });
    await act(async () => {
      checkbox().click();
    });
    await act(async () => {
      buttonByText("Listo").click();
    });
    expect(mocks.acknowledgeRecoveryCodesAction).toHaveBeenCalledWith(SET_ID);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("si no se pudo confirmar, muestra el error y NO termina (se puede reintentar)", async () => {
    mocks.acknowledgeRecoveryCodesAction.mockResolvedValue({
      status: "error",
      message: "No pudimos confirmar tus códigos.",
    });
    await act(async () => {
      checkbox().click();
    });
    await act(async () => {
      buttonByText("Listo").click();
    });
    expect(host.textContent).toContain("No pudimos confirmar tus códigos.");
    expect(onDone).not.toHaveBeenCalled();
    expect(buttonByText("Listo").disabled).toBe(false);
  });

  it("«Copiar todos» copia los códigos uno por línea", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await act(async () => {
      buttonByText("Copiar todos").click();
    });
    expect(writeText).toHaveBeenCalledWith(CODES.join("\n"));
    expect(host.textContent).toContain("Copiados");
  });

  it("«Descargar (.txt)» arma el archivo en el navegador (un Blob), con los códigos y sin ningún correo", async () => {
    let blob: Blob | null = null;
    URL.createObjectURL = vi.fn((value: Blob) => {
      blob = value;
      return "blob:prueba";
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await act(async () => {
      buttonByText("Descargar (.txt)").click();
    });
    expect(click).toHaveBeenCalledTimes(1);
    expect(blob).not.toBeNull();
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob!);
    });
    for (const [index, code] of CODES.entries()) expect(text).toContain(`${index + 1}. ${code}`);
    expect(text).toContain("Códigos de respaldo de Cotiza Prime");
    expect(text).not.toMatch(/@/);
  });

  it("el título recibe el foco al aparecer", () => {
    expect(document.activeElement?.tagName).toBe("H2");
    expect(document.activeElement?.textContent).toBe("Tus códigos de respaldo");
  });
});
