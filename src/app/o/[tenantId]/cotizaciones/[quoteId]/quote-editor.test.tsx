// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// El editor de la cotización con las reglas de precio y descuento (H-041). Las acciones del servidor se reemplazan: aquí se mira
// lo que ve y puede hacer cada persona, no el guardado.
const mocks = vi.hoisted(() => ({
  saveQuoteDraftAction: vi.fn(),
  searchQuoteCatalogAction: vi.fn(),
}));
vi.mock("@/lib/quotes/actions", () => ({
  saveQuoteDraftAction: mocks.saveQuoteDraftAction,
  searchQuoteCatalogAction: mocks.searchQuoteCatalogAction,
}));

import {
  newCatalogLine,
  newFreeLine,
  type EditorLine,
  type EditorState,
} from "@/lib/quotes/editor-model";
import { QuoteEditor } from "./quote-editor";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const QUOTE_ID = "22222222-2222-4222-8222-222222222222";
const CATALOG_ID = "33333333-3333-4333-8333-333333333333";

let host: HTMLDivElement;
let root: Root;

function lockedLine(price = "10000", catalogPriceTodayClp?: number): EditorLine {
  return {
    ...newCatalogLine("line-1", {
      id: CATALOG_ID,
      name: "Flete Santiago",
      description: null,
      unit: "service",
      unitPriceClp: 10_000,
      taxTreatment: "taxable",
      priceLocked: true,
    }),
    price,
    ...(catalogPriceTodayClp === undefined ? {} : { catalogPriceTodayClp }),
  };
}
const stateWith = (lines: EditorLine[]): EditorState => ({
  customerId: "44444444-4444-4444-8444-444444444444",
  lines,
  globalDiscountKind: "none",
  globalDiscount: "",
  validityMode: "days",
  validityDays: "15",
  validityDate: "",
  observations: "",
  conditions: "",
});

async function mount(
  lines: EditorLine[],
  rules: { maxDiscountBp: number | null; canOverride: boolean; maxDiscountUnknown?: boolean },
) {
  await act(async () => {
    root.render(
      createElement(QuoteEditor, {
        tenantId: TENANT_ID,
        quoteId: QUOTE_ID,
        initialState: stateWith(lines),
        initialRevision: 1,
        taxRateBp: 1900,
        savedValidUntil: null,
        initialCatalog: [],
        rules,
      }),
    );
  });
}
const byId = (id: string) => host.querySelector<HTMLInputElement>(`#${id}`)!;
const testId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  mocks.saveQuoteDraftAction.mockReset();
  mocks.searchQuoteCatalogAction.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("el precio bloqueado en el editor", () => {
  it("el Comercial lo ve fijo, con candado y la frase, y no se puede escribir", async () => {
    await mount([lockedLine()], { maxDiscountBp: 1_000, canOverride: false });
    const price = byId("line-1-price");
    expect(price.readOnly).toBe(true);
    expect(price.value).toBe("10000");
    expect(testId("price-lock-icon")).not.toBeNull();
    expect(testId("price-locked-note")!.textContent).toBe("Precio bloqueado por tu organización");
    expect(testId("price-locked-override-note")).toBeNull();
    // Ya está al precio de catálogo: no hay a qué volver.
    expect(testId("use-catalog-price")).toBeNull();
  });

  it("si el precio guardado difiere, ofrece «Usar el precio con que se agregó» y lo restaura", async () => {
    await mount([lockedLine("8000")], { maxDiscountBp: 1_000, canOverride: false });
    const button = testId("use-catalog-price") as HTMLButtonElement;
    expect(button.textContent).toBe("Usar el precio con que se agregó ($10.000)");
    // Sin precio de hoy distinto, no se dice nada del catálogo de hoy.
    expect(testId("catalog-price-today")).toBeNull();
    // El precio de otro valor no se cuela: el servidor lo rechazaría, y la pantalla ya lo marca.
    expect(host.textContent).toContain("El precio de este servicio está bloqueado");
    await act(async () => button.click());
    expect(byId("line-1-price").value).toBe("10000");
    expect(testId("use-catalog-price")).toBeNull();
    expect(host.textContent).not.toContain("El precio de este servicio está bloqueado");
  });

  it("el botón va a todo el ancho debajo de la grilla, no dentro de la columna del precio", async () => {
    await mount([lockedLine("8000")], { maxDiscountBp: 1_000, canOverride: false });
    const button = testId("use-catalog-price") as HTMLButtonElement;
    const priceCell = byId("line-1-price").closest("div.flex-col")!;
    expect(priceCell.contains(button)).toBe(false);
    expect(button.parentElement!.className).toContain("col-span-2");
    expect(button.className).toContain("w-full");
    expect(button.className).toContain("min-h-11");
  });

  it("si el catálogo hoy dice otro precio, lo dice junto al botón", async () => {
    await mount([lockedLine("8000", 12_000)], { maxDiscountBp: 1_000, canOverride: false });
    expect(testId("use-catalog-price")!.textContent).toBe(
      "Usar el precio con que se agregó ($10.000)",
    );
    expect(testId("catalog-price-today")!.textContent).toBe("El catálogo hoy dice $12.000.");
  });

  it("si no se pudo leer el tope, lo avisa en vez de callar como «sin tope»", async () => {
    await mount([lockedLine()], {
      maxDiscountBp: null,
      canOverride: false,
      maxDiscountUnknown: true,
    });
    expect(testId("discount-cap-hint")).toBeNull();
    expect(testId("discount-cap-unknown")!.textContent).toBe(
      "No pudimos leer el descuento máximo de tu organización. Lo revisamos igual al guardar.",
    );
  });

  it("el Dueño y el Administrador lo editan, con la ayuda de que queda registrado", async () => {
    await mount([lockedLine()], { maxDiscountBp: 1_000, canOverride: true });
    const price = byId("line-1-price");
    expect(price.readOnly).toBe(false);
    expect(testId("price-lock-icon")).toBeNull();
    expect(testId("price-locked-override-note")!.textContent).toBe(
      "Precio bloqueado en el catálogo. Puedes cambiarlo; quedará registrado.",
    );
    await type(price, "8000");
    expect(host.textContent).not.toContain("El precio de este servicio está bloqueado");
    expect(testId("use-catalog-price")).toBeNull();
  });

  it("una línea libre o de un servicio sin candado se edita normal", async () => {
    await mount([{ ...newFreeLine("line-1"), name: "Algo", price: "5000" }], {
      maxDiscountBp: 1_000,
      canOverride: false,
    });
    expect(byId("line-1-price").readOnly).toBe(false);
    expect(testId("price-locked-note")).toBeNull();
  });
});

describe("el descuento máximo en el editor", () => {
  it("«Máximo 10 %» junto al descuento de la línea y al general (solo para el Comercial)", async () => {
    await mount([lockedLine()], { maxDiscountBp: 1_000, canOverride: false });
    expect(testId("discount-cap-hint")!.textContent).toBe("Máximo 10 %");
    expect(testId("global-discount-cap-hint")!.textContent).toBe("Máximo 10 %");
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount([lockedLine()], { maxDiscountBp: 1_000, canOverride: true });
    expect(testId("discount-cap-hint")).toBeNull();
    expect(testId("global-discount-cap-hint")).toBeNull();
  });

  it("con tope 0 dice que la organización no permite descuentos; sin tope no dice nada", async () => {
    await mount([lockedLine()], { maxDiscountBp: 0, canOverride: false });
    expect(testId("discount-cap-hint")!.textContent).toBe("Tu organización no permite descuentos");
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount([lockedLine()], { maxDiscountBp: null, canOverride: false });
    expect(testId("discount-cap-hint")).toBeNull();
  });

  it("15 % da el error junto a la línea y no deja guardar; 10 % guarda", async () => {
    mocks.saveQuoteDraftAction.mockResolvedValue({ status: "saved", revision: 2 });
    await mount([lockedLine()], { maxDiscountBp: 1_000, canOverride: false });
    await choose(byId("line-1-discount-kind") as unknown as HTMLSelectElement, "percent");
    await type(byId("line-1-discount"), "15");
    expect(host.textContent).toContain(
      "El descuento pasa del máximo que permite tu organización (10 %).",
    );
    expect(byId("line-1-discount").getAttribute("aria-invalid")).toBe("true");
    const save = testId("save-quote") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(testId("save-status")!.textContent).toBe(
      "Corrige los datos marcados para poder guardar.",
    );

    await type(byId("line-1-discount"), "10");
    expect(host.textContent).not.toContain("pasa del máximo");
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(mocks.saveQuoteDraftAction).toHaveBeenCalledTimes(1);
  });

  it("el descuento general sobre el tope también se marca", async () => {
    await mount([lockedLine()], { maxDiscountBp: 1_000, canOverride: false });
    await choose(byId("global-discount-kind") as unknown as HTMLSelectElement, "percent");
    await type(byId("global-discount"), "11");
    expect(host.querySelector("#global-discount-error")!.textContent).toMatch(/máximo que permite/);
    expect((testId("save-quote") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("errores por línea que manda el servidor", () => {
  it("se muestran junto a la línea mientras no se cambie nada, y desaparecen al editar", async () => {
    mocks.saveQuoteDraftAction.mockResolvedValue({
      status: "invalid",
      message: "Tu organización cambió sus reglas de precio. Recarga para ver las vigentes.",
      fieldErrors: {
        "items.0.price":
          "El precio de este servicio está bloqueado. Usa el precio con que se agregó a la cotización.",
      },
    });
    await mount([{ ...newFreeLine("line-1"), name: "Algo", price: "5000" }], {
      maxDiscountBp: null,
      canOverride: false,
    });
    await type(byId("line-1-price"), "6000");
    await act(async () => (testId("save-quote") as HTMLButtonElement).click());
    expect(host.textContent).toContain(
      "Tu organización cambió sus reglas de precio. Recarga para ver las vigentes.",
    );
    expect(host.querySelector("#line-1-price-error")!.textContent).toContain("bloqueado");

    await type(byId("line-1-price"), "7000");
    expect(host.querySelector("#line-1-price-error")).toBeNull();
  });
});
