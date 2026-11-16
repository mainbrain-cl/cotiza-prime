// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  regenerateRecoveryCodesAction: vi.fn(),
  acknowledgeRecoveryCodesAction: vi.fn(),
  startTotpEnrollmentAction: vi.fn(),
  confirmTotpEnrollmentAction: vi.fn(),
  cancelTotpEnrollmentAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));
vi.mock("@/lib/auth/recovery-code-actions", () => ({
  regenerateRecoveryCodesAction: mocks.regenerateRecoveryCodesAction,
  acknowledgeRecoveryCodesAction: mocks.acknowledgeRecoveryCodesAction,
}));
vi.mock("@/lib/auth/second-step-actions", () => ({
  startTotpEnrollmentAction: mocks.startTotpEnrollmentAction,
  confirmTotpEnrollmentAction: mocks.confirmTotpEnrollmentAction,
  cancelTotpEnrollmentAction: mocks.cancelTotpEnrollmentAction,
}));

import { TwoStepPanel, type RecoveryInfo } from "./two-step-panel";

const SET_ID = "33333333-3333-4333-8333-333333333333";
const CODES = ["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"];
const EMAIL = "ana@ejemplo.test";

let host: HTMLDivElement;
let root: Root;

const baseProps = {
  active: true,
  sinceLabel: "10-11-2026",
  justEnabled: false,
  justCodesCreated: false,
  justRecoveryUsed: false,
  noticeEmail: EMAIL,
  accountEmail: EMAIL,
  recovery: null as RecoveryInfo | null,
};

async function mount(props: Partial<typeof baseProps> = {}) {
  await act(async () => {
    root.render(createElement(TwoStepPanel, { ...baseProps, ...props }));
  });
}
const text = () => host.textContent ?? "";
const buttonByText = (label: string) =>
  [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(label))!;
async function click(label: string) {
  await act(async () => {
    buttonByText(label).click();
  });
}
async function typeInto(name: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("TwoStepPanel activada: códigos de respaldo", () => {
  it("sin códigos: lo dice con el riesgo y ofrece «Crear códigos de respaldo»", async () => {
    await mount({ recovery: { total: 0, acknowledged: false, createdLabel: null } });
    expect(text()).toContain("La verificación en dos pasos está activa");
    expect(text()).toContain(
      "No tienes códigos de respaldo. Si pierdes tu teléfono, no podrás entrar.",
    );
    expect(buttonByText("Crear códigos de respaldo")).toBeTruthy();
    expect(text()).not.toContain("Generar códigos nuevos");
  });

  it("con códigos guardados: dice cuándo se crearon y ofrece «Generar códigos nuevos», sin alarma", async () => {
    await mount({ recovery: { total: 10, acknowledged: true, createdLabel: "16-11-2026" } });
    expect(text()).toContain("creados el 16-11-2026");
    expect(buttonByText("Generar códigos nuevos")).toBeTruthy();
    expect(text()).not.toContain("No confirmaste");
    expect(text()).not.toContain("No tienes códigos");
  });

  it("con códigos que no se confirmaron: avisa «No confirmaste que guardaste tus códigos de respaldo»", async () => {
    await mount({ recovery: { total: 10, acknowledged: false, createdLabel: "16-11-2026" } });
    expect(text()).toContain("No confirmaste que guardaste tus códigos de respaldo");
    expect(buttonByText("Generar códigos nuevos")).toBeTruthy();
  });

  it("si no se pudo leer el estado, lo dice y deja generar códigos nuevos", async () => {
    await mount({ recovery: null });
    expect(text()).toContain("No pudimos revisar tus códigos de respaldo");
    expect(buttonByText("Generar códigos nuevos")).toBeTruthy();
  });

  it("el aviso de códigos creados y el de activada se muestran cuando la dirección los trae", async () => {
    await mount({
      justEnabled: true,
      justCodesCreated: true,
      recovery: { total: 10, acknowledged: true, createdLabel: "16-11-2026" },
    });
    expect(text()).toContain("Listo: la verificación en dos pasos quedó activa.");
    expect(text()).toContain("Listo: tus códigos de respaldo nuevos quedaron creados.");
  });

  it("crear pide la contraseña y el código de 6 números; con códigos previos avisa que los anteriores dejarán de servir", async () => {
    await mount({ recovery: { total: 10, acknowledged: true, createdLabel: "16-11-2026" } });
    await click("Generar códigos nuevos");
    expect(host.querySelector('input[name="password"]')?.getAttribute("type")).toBe("password");
    expect(host.querySelector('input[name="password"]')?.getAttribute("autocomplete")).toBe(
      "current-password",
    );
    expect(host.querySelector('input[name="code"]')?.getAttribute("autocomplete")).toBe(
      "one-time-code",
    );
    expect(text()).toContain("Los códigos anteriores dejarán de servir");
    expect(text()).toContain("no uno de respaldo");
    await click("Cancelar");
    expect(host.querySelector("form")).toBeNull();
  });

  it("sin códigos previos NO dice que los anteriores dejarán de servir", async () => {
    await mount({ recovery: { total: 0, acknowledged: false, createdLabel: null } });
    await click("Crear códigos de respaldo");
    expect(text()).not.toContain("Los códigos anteriores dejarán de servir");
  });

  it("la contraseña mala se muestra en su campo y no sale de la pantalla de seguridad", async () => {
    mocks.regenerateRecoveryCodesAction.mockResolvedValue({
      status: "error",
      fieldErrors: { password: "La contraseña no es correcta." },
    });
    await mount({ recovery: { total: 0, acknowledged: false, createdLabel: null } });
    await click("Crear códigos de respaldo");
    await typeInto("code", "123456");
    await typeInto("password", "x");
    await submit();
    expect(text()).toContain("La contraseña no es correcta.");
    expect(host.querySelector("[data-testid=recovery-codes-screen]")).toBeNull();
  });

  it("al crear, aparece la pantalla de códigos; «Listo» confirma el juego y vuelve con el aviso de códigos creados", async () => {
    mocks.regenerateRecoveryCodesAction.mockResolvedValue({
      status: "created",
      recoveryCodes: CODES,
      setId: SET_ID,
    });
    mocks.acknowledgeRecoveryCodesAction.mockResolvedValue({ status: "ok" });
    await mount({ recovery: { total: 10, acknowledged: true, createdLabel: "16-11-2026" } });
    await click("Generar códigos nuevos");
    await typeInto("code", "123456");
    await typeInto("password", "x");
    await submit();
    const shown = [...host.querySelectorAll('[data-testid="recovery-code"]')].map(
      (node) => node.textContent,
    );
    expect(shown).toEqual(CODES);
    await act(async () => {
      host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    });
    await click("Listo");
    expect(mocks.acknowledgeRecoveryCodesAction).toHaveBeenCalledWith(SET_ID);
    expect(mocks.replace).toHaveBeenCalledWith("/cuenta/seguridad?aviso=codigos");
    // Los códigos ya no están en la pantalla.
    expect(host.querySelector('[data-testid="recovery-code"]')).toBeNull();
  });
});

describe("TwoStepPanel al activar: los códigos de respaldo", () => {
  const ENROLLMENT = {
    factorId: "22222222-2222-4222-8222-222222222222",
    qrCode: "data:image/svg+xml;charset=utf-8,x",
    secret: "ABCDEFGHJKLMNPQR",
    uri: "otpauth://totp/x",
  };
  async function reachConfirmStep() {
    mocks.startTotpEnrollmentAction.mockResolvedValue({
      status: "started",
      enrollment: ENROLLMENT,
    });
    await mount({ active: false, recovery: null });
    await click("Activar la verificación en dos pasos");
    await click("Ya la escaneé");
    await typeInto("code", "123456");
    await typeInto("password", "x");
  }

  it("al quedar activa, muestra la pantalla de códigos aunque la página ya pase a «activa»", async () => {
    mocks.confirmTotpEnrollmentAction.mockResolvedValue({
      status: "enabled",
      recoveryCodes: CODES,
      setId: SET_ID,
    });
    await reachConfirmStep();
    await submit();
    expect(host.querySelector('[data-testid="recovery-codes-screen"]')).not.toBeNull();
    // La página se vuelve a pedir al servidor y trae `active: true`: los códigos se quedan.
    await mount({ active: true, recovery: { total: 0, acknowledged: false, createdLabel: null } });
    expect(
      [...host.querySelectorAll('[data-testid="recovery-code"]')].map((node) => node.textContent),
    ).toEqual(CODES);
  });

  it("«Listo» lleva a la pantalla de seguridad con el aviso de activada", async () => {
    mocks.confirmTotpEnrollmentAction.mockResolvedValue({
      status: "enabled",
      recoveryCodes: CODES,
      setId: SET_ID,
    });
    mocks.acknowledgeRecoveryCodesAction.mockResolvedValue({ status: "ok" });
    await reachConfirmStep();
    await submit();
    await act(async () => {
      host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    });
    await click("Listo");
    expect(mocks.replace).toHaveBeenCalledWith("/cuenta/seguridad?aviso=activada");
  });

  it("si no se pudieron crear los códigos: «La verificación quedó activa, pero no pudimos crear tus códigos de respaldo. Créalos ahora.» con el botón de crear", async () => {
    mocks.confirmTotpEnrollmentAction.mockResolvedValue({ status: "enabled_without_codes" });
    await reachConfirmStep();
    await submit();
    await mount({ active: true, recovery: { total: 0, acknowledged: false, createdLabel: null } });
    expect(text()).toContain(
      "La verificación quedó activa, pero no pudimos crear tus códigos de respaldo. Créalos ahora.",
    );
    expect(buttonByText("Crear códigos de respaldo")).toBeTruthy();
    expect(mocks.replace).toHaveBeenCalledWith("/cuenta/seguridad?aviso=activada");
  });

  it("un error de la activación (contraseña mala) se queda en el formulario y no muestra códigos", async () => {
    mocks.confirmTotpEnrollmentAction.mockResolvedValue({
      status: "error",
      fieldErrors: { password: "La contraseña no es correcta." },
    });
    await reachConfirmStep();
    await submit();
    expect(text()).toContain("La contraseña no es correcta.");
    expect(host.querySelector('[data-testid="recovery-codes-screen"]')).toBeNull();
  });
});

describe("TwoStepPanel tras entrar con un código de respaldo", () => {
  it("sin verificación activa y con el aviso `respaldo`: dice qué pasó y que hay que activarla de nuevo", async () => {
    await mount({ active: false, justRecoveryUsed: true, recovery: null });
    expect(text()).toContain(
      "Entraste con un código de respaldo. Desactivamos la verificación en dos pasos y cerramos tus otras sesiones. Actívala de nuevo con tu teléfono; si recuperas el anterior, borra de su aplicación la entrada vieja de Cotiza Prime.",
    );
    expect(buttonByText("Activar la verificación en dos pasos")).toBeTruthy();
  });

  it("sin el aviso en la dirección no se muestra", async () => {
    await mount({ active: false, recovery: null });
    expect(text()).not.toContain("Entraste con un código de respaldo");
  });
});
