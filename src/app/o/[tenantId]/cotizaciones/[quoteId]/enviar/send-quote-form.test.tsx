// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// «Enviar» con textos de correo guardados (H-048b): el selector, la confirmación al reemplazar un texto editado y el aviso de variables
// sin completar. La acción de enviar se reemplaza: aquí se mira lo que ve y puede hacer la persona.
const mocks = vi.hoisted(() => ({ sendQuoteAction: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/quotes/send/actions", () => ({ sendQuoteAction: mocks.sendQuoteAction }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import type { EmailSnippetOption } from "@/lib/snippets/email-body";
import { SendQuoteForm } from "./send-quote-form";

const DEFAULT_TEXT = "Estimado/a Cliente Ficticio:\n\nEl texto de siempre.";
const OPTIONS: EmailSnippetOption[] = [
  {
    id: "s1",
    name: "Saludo formal",
    text: "Estimado/a Cliente Ficticio: le enviamos la cotización.",
    isDefault: true,
  },
  {
    id: "s2",
    name: "Saludo breve",
    text: "Hola Cliente Ficticio, adjuntamos la cotización.",
    isDefault: false,
  },
];

let host: HTMLDivElement;
let root: Root;

async function mount(over: Partial<Parameters<typeof SendQuoteForm>[0]> = {}) {
  await act(async () => {
    root.render(
      createElement(SendQuoteForm, {
        tenantId: "11111111-1111-4111-8111-111111111111",
        quoteId: "22222222-2222-4222-8222-222222222222",
        expectedRevision: 1,
        quotePath: "/o/x/cotizaciones/y",
        initialSubject: "Cotización COT-2026-0001 de Empresa Ficticia",
        initialBody: OPTIONS[0].text,
        organizationName: "Empresa Ficticia",
        brandPrimary: "#2b54e0",
        brandOnPrimary: "#ffffff",
        brandText: "#2b54e0",
        customerName: "Cliente Ficticio",
        maskedRecipient: "c***@ejemplo.test",
        replyTo: null,
        pdfSrc: "/pdf",
        snippetOptions: OPTIONS,
        snippetsUnavailable: false,
        defaultText: DEFAULT_TEXT,
        ...over,
      }),
    );
  });
}
const body = () => host.querySelector<HTMLTextAreaElement>('[data-testid="send-body"]')!;
const select = () => host.querySelector<HTMLSelectElement>('[data-testid="send-snippet-select"]');
const submit = () => host.querySelector<HTMLButtonElement>('[data-testid="send-submit"]')!;
const testId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function typeBody(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(body(), value);
    body().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** Elegir en la lista NO cambia el correo: lo cambia «Usar este texto». */
async function pick(id: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select()!, id);
    select()!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const snippetUseButton = () =>
  host.querySelector<HTMLButtonElement>('[data-testid="send-snippet-use"]')!;
async function choose(id: string) {
  await pick(id);
  await click(snippetUseButton());
}
async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

beforeEach(() => {
  mocks.sendQuoteAction.mockReset();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }) as unknown as typeof window.matchMedia;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Enviar: textos de correo guardados (H-048b)", () => {
  it("parte con el texto que le pasa la página y ofrece los textos guardados, marcando el inicial", async () => {
    await mount();
    expect(body().value).toBe(OPTIONS[0].text);
    const labels = Array.from(select()!.options).map((option) => option.textContent);
    expect(labels).toEqual([
      "Elige un texto guardado…",
      "Texto de siempre",
      "Saludo formal (texto inicial)",
      "Saludo breve",
    ]);
  });

  it("elegir en la lista no cambia el correo (con el teclado, las flechas no lo reemplazan); solo «Usar este texto» lo cambia", async () => {
    await mount();
    expect(snippetUseButton().disabled).toBe(true);
    await pick("s2");
    expect(body().value).toBe(OPTIONS[0].text);
    expect(snippetUseButton().disabled).toBe(false);
    await click(snippetUseButton());
    expect(body().value).toBe(OPTIONS[1].text);
    // aplicado, la lista vuelve a «Elige…» y el botón a apagado
    expect(select()!.value).toBe("");
    expect(snippetUseButton().disabled).toBe(true);
  });

  it("se puede volver al texto de siempre, también cuando la organización no tiene texto inicial", async () => {
    await mount({
      initialBody: DEFAULT_TEXT,
      snippetOptions: OPTIONS.filter((option) => !option.isDefault),
    });
    await choose("s2");
    expect(body().value).toBe(OPTIONS[1].text);
    await choose("__texto-de-siempre__");
    expect(body().value).toBe(DEFAULT_TEXT);
  });

  it("sin textos guardados no hay selector", async () => {
    await mount({ snippetOptions: [] });
    expect(select()).toBeNull();
  });

  it("si no se pudieron leer los textos, lo dice y se puede escribir a mano", async () => {
    await mount({ snippetOptions: [], snippetsUnavailable: true });
    expect(select()).toBeNull();
    expect(host.textContent).toContain("No pudimos cargar tus textos guardados");
    expect(submit().disabled).toBe(false);
  });

  it("elegir un texto sin haber cambiado el actual lo pone directo, sin preguntar", async () => {
    await mount();
    await choose("s2");
    expect(body().value).toBe(OPTIONS[1].text);
    expect(testId("send-snippet-confirm")).toBeNull();
  });

  it("si la persona cambió el texto, pide confirmar: «Mantener» no cambia nada y «Reemplazar» lo reemplaza", async () => {
    await mount();
    await typeBody("Lo que escribí yo.");
    await choose("s2");
    expect(testId("send-snippet-confirm")).not.toBeNull();
    expect(body().value).toBe("Lo que escribí yo.");
    // la confirmación se anuncia: el foco pasa a «Reemplazar el texto»
    expect(document.activeElement).toBe(testId("send-snippet-replace"));
    await click(testId("send-snippet-keep")!);
    // «Mantener» devuelve el foco a la lista
    expect(document.activeElement).toBe(select());
    expect(testId("send-snippet-confirm")).toBeNull();
    expect(body().value).toBe("Lo que escribí yo.");
    await choose("s2");
    await click(testId("send-snippet-replace")!);
    expect(testId("send-snippet-confirm")).toBeNull();
    expect(body().value).toBe(OPTIONS[1].text);
    // ya reemplazado y sin editar, elegir otro texto no pregunta
    await choose("s1");
    expect(testId("send-snippet-confirm")).toBeNull();
    expect(body().value).toBe(OPTIONS[0].text);
  });

  it("después de elegir un texto, el error de formato en vivo sigue viéndose bajo el campo", async () => {
    await mount();
    await choose("s2");
    await typeBody("Mira [https://uno.ejemplo](https://otro.ejemplo)");
    expect(host.textContent).toMatch(/enlace/i);
    expect(submit().disabled).toBe(true);
  });

  it("con una variable sin completar avisa y no deja enviar; al quitarla, sí", async () => {
    await mount();
    expect(testId("send-unresolved-variables")).toBeNull();
    await typeBody("Estimado/a {{cliente}}: adjuntamos la cotización.");
    expect(testId("send-unresolved-variables")).not.toBeNull();
    expect(submit().disabled).toBe(true);
    await typeBody("Estimado/a Ana: adjuntamos la cotización.");
    expect(testId("send-unresolved-variables")).toBeNull();
    expect(submit().disabled).toBe(false);
  });

  it("unas llaves que no son una de las cuatro variables no bloquean (se envían como texto)", async () => {
    await mount();
    await typeBody("Hola {{otra}} y {algo}.");
    expect(testId("send-unresolved-variables")).toBeNull();
    expect(submit().disabled).toBe(false);
  });
});
