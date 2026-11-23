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
  getQuoteCatalogItemAction: vi.fn(),
}));
vi.mock("@/lib/quotes/actions", () => ({
  saveQuoteDraftAction: mocks.saveQuoteDraftAction,
  searchQuoteCatalogAction: mocks.searchQuoteCatalogAction,
  getQuoteCatalogItemAction: mocks.getQuoteCatalogItemAction,
}));

import {
  newCatalogLine,
  newFreeLine,
  type EditorLine,
  type EditorState,
} from "@/lib/quotes/editor-model";
import { NO_SNIPPETS, type QuoteFieldSnippets } from "@/lib/snippets/quote-fields";
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
  exclusions: "",
  footerNote: "",
});

async function mount(
  lines: EditorLine[],
  rules: { maxDiscountBp: number | null; canOverride: boolean; maxDiscountUnknown?: boolean },
  extra: { snippets?: QuoteFieldSnippets; manageSnippetsHref?: string | null } = {},
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
        snippets: extra.snippets ?? NO_SNIPPETS,
        manageSnippetsHref: extra.manageSnippetsHref ?? null,
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

async function typeText(el: HTMLElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  mocks.saveQuoteDraftAction.mockReset();
  mocks.searchQuoteCatalogAction.mockReset();
  mocks.getQuoteCatalogItemAction.mockReset();
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
          "El precio de este servicio cambió o se bloqueó en el catálogo. Actualiza la línea para usar el precio de hoy.",
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
    expect(host.querySelector("#line-1-price-error")!.textContent).toContain("Actualiza la línea");

    await type(byId("line-1-price"), "7000");
    expect(host.querySelector("#line-1-price-error")).toBeNull();
  });
});

describe("poner al día una línea cuando el catálogo cambió con la cotización abierta (H-041)", () => {
  const todayItem = (unitPriceClp: number, priceLocked = true) => ({
    id: CATALOG_ID,
    name: "Flete Santiago",
    description: null,
    unit: "service",
    unitPriceClp,
    taxTreatment: "taxable" as const,
    priceLocked,
  });
  const staleSaveError = {
    status: "invalid",
    message: "Hay servicios con el precio bloqueado a otro precio. Revisa las líneas marcadas.",
    fieldErrors: {
      "items.0.price":
        "El precio de este servicio cambió o se bloqueó en el catálogo. Actualiza la línea para usar el precio de hoy.",
    },
  };

  it("el caso sin salida: el servidor rechaza el precio y la línea se actualiza al de hoy sin perder lo demás", async () => {
    mocks.saveQuoteDraftAction.mockResolvedValue(staleSaveError);
    mocks.getQuoteCatalogItemAction.mockResolvedValue({ status: "found", item: todayItem(12_000) });
    await mount([{ ...lockedLine(), quantity: "3" }], { maxDiscountBp: 1_000, canOverride: false });
    // Antes de guardar no hay nada que actualizar: el catálogo no se sabe distinto.
    expect(testId("refresh-catalog-price")).toBeNull();

    await act(async () => (testId("save-quote") as HTMLButtonElement).click());
    expect(byId("line-1-price").readOnly).toBe(true);
    // Restaurar daría los mismos $10.000: no se ofrece; sí se ofrece actualizar.
    expect(testId("use-catalog-price")).toBeNull();
    expect(testId("refresh-catalog-price")!.textContent).toBe("Actualizar al precio de hoy");

    await act(async () => testId("refresh-catalog-price")!.click());
    expect(mocks.getQuoteCatalogItemAction).toHaveBeenCalledWith(TENANT_ID, CATALOG_ID);
    // La línea es otra (otro id), con el precio de hoy, y se quitaron el error y el botón.
    const price = host.querySelector<HTMLInputElement>('input[id$="-price"]')!;
    expect(price.id).not.toBe("line-1-price");
    expect(price.value).toBe("12000");
    expect(price.readOnly).toBe(true);
    expect(host.querySelector('[id$="-price-error"]')).toBeNull();
    expect(testId("refresh-catalog-price")).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[id$="-quantity"]')!.value).toBe("3");
    expect(host.textContent).toContain("se actualizó al precio de hoy");
  });

  it("si el catálogo bajó, lo dice aunque la línea siga con su precio, y se puede actualizar", async () => {
    mocks.getQuoteCatalogItemAction.mockResolvedValue({ status: "found", item: todayItem(8_000) });
    await mount([lockedLine("10000", 8_000)], { maxDiscountBp: 1_000, canOverride: false });
    expect(testId("catalog-price-today")!.textContent).toBe("El catálogo hoy dice $8.000.");
    expect(testId("use-catalog-price")).toBeNull();
    await act(async () => testId("refresh-catalog-price")!.click());
    expect(host.querySelector<HTMLInputElement>('input[id$="-price"]')!.value).toBe("8000");
    expect(testId("catalog-price-today")).toBeNull();
  });

  it("si el servicio se bloqueó después de abrir, la línea pasa a estar bloqueada", async () => {
    mocks.saveQuoteDraftAction.mockResolvedValue(staleSaveError);
    mocks.getQuoteCatalogItemAction.mockResolvedValue({ status: "found", item: todayItem(10_000) });
    const open = { ...lockedLine("8000"), priceLocked: false };
    await mount([open], { maxDiscountBp: 1_000, canOverride: false });
    expect(byId("line-1-price").readOnly).toBe(false);
    await act(async () => (testId("save-quote") as HTMLButtonElement).click());
    await act(async () => testId("refresh-catalog-price")!.click());
    const price = host.querySelector<HTMLInputElement>('input[id$="-price"]')!;
    expect(price.value).toBe("10000");
    expect(price.readOnly).toBe(true);
    expect(testId("price-locked-note")).not.toBeNull();
  });

  it("sin cambios en el catálogo y sin error del servidor no se ofrece actualizar", async () => {
    await mount([lockedLine("10000", 10_000)], { maxDiscountBp: 1_000, canOverride: false });
    expect(testId("refresh-catalog-price")).toBeNull();
    expect(testId("catalog-price-today")).toBeNull();
  });

  it("quien se salta el candado no ve el botón por un cambio de catálogo", async () => {
    await mount([lockedLine("10000", 8_000)], { maxDiscountBp: null, canOverride: true });
    expect(testId("refresh-catalog-price")).toBeNull();
  });

  it("si el servicio ya no está disponible lo dice y la línea no cambia", async () => {
    mocks.getQuoteCatalogItemAction.mockResolvedValue({ status: "missing" });
    await mount([lockedLine("10000", 8_000)], { maxDiscountBp: 1_000, canOverride: false });
    await act(async () => testId("refresh-catalog-price")!.click());
    expect(testId("refresh-catalog-price-error")!.textContent).toContain("ya no está disponible");
    // No sugiere una línea libre (el hueco aceptado de la pregunta 18).
    expect(testId("refresh-catalog-price-error")!.textContent).not.toContain("línea libre");
    expect(byId("line-1-price").value).toBe("10000");
  });

  it("si la consulta falla por la conexión lo dice y la línea no cambia", async () => {
    mocks.getQuoteCatalogItemAction.mockRejectedValue(new TypeError("Failed to fetch"));
    await mount([lockedLine("10000", 8_000)], { maxDiscountBp: 1_000, canOverride: false });
    await act(async () => testId("refresh-catalog-price")!.click());
    expect(testId("refresh-catalog-price-error")!.textContent).toContain("Sin conexión");
    expect(byId("line-1-price").value).toBe("10000");
  });

  it("si la base no pudo leer el catálogo lo dice distinto a «no está disponible»", async () => {
    mocks.getQuoteCatalogItemAction.mockResolvedValue({ status: "failed" });
    await mount([lockedLine("10000", 8_000)], { maxDiscountBp: 1_000, canOverride: false });
    await act(async () => testId("refresh-catalog-price")!.click());
    const text = testId("refresh-catalog-price-error")!.textContent!;
    expect(text).toContain("No pudimos leer el catálogo");
    expect(text).not.toContain("ya no está disponible");
  });

  it("una línea de un servicio desactivado no ofrece actualizar", async () => {
    await mount([{ ...lockedLine("10000", 8_000), catalogInactive: true }], {
      maxDiscountBp: 1_000,
      canOverride: false,
    });
    expect(testId("refresh-catalog-price")).toBeNull();
  });

  it("después de actualizar, el foco pasa al precio de la línea nueva", async () => {
    mocks.getQuoteCatalogItemAction.mockResolvedValue({ status: "found", item: todayItem(8_000) });
    await mount([lockedLine("10000", 8_000)], { maxDiscountBp: 1_000, canOverride: false });
    await act(async () => testId("refresh-catalog-price")!.click());
    const price = host.querySelector<HTMLInputElement>('input[id$="-price"]')!;
    expect(price.id).not.toBe("line-1-price");
    expect(document.activeElement).toBe(price);
  });

  it("no se pierde lo que la persona escribió mientras se consulta el catálogo", async () => {
    let resolve!: (value: unknown) => void;
    mocks.getQuoteCatalogItemAction.mockReturnValue(new Promise((r) => (resolve = r)));
    await mount([lockedLine("10000", 8_000)], { maxDiscountBp: 1_000, canOverride: false });
    await act(async () => testId("refresh-catalog-price")!.click());
    // mientras la consulta sigue en curso, guardar no se ofrece
    expect((testId("save-quote") as HTMLButtonElement).disabled).toBe(true);
    await type(byId("line-1-quantity"), "5");
    await act(async () => resolve({ status: "found", item: todayItem(8_000) }));
    expect(host.querySelector<HTMLInputElement>('input[id$="-quantity"]')!.value).toBe("5");
    expect(host.querySelector<HTMLInputElement>('input[id$="-price"]')!.value).toBe("8000");
    expect((testId("save-quote") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("los textos de la cotización: exclusiones, notas al pie y «Insertar texto guardado» (H-048b)", () => {
  const RULES = { maxDiscountBp: null, canOverride: true };
  const withSnippets = (over: Partial<QuoteFieldSnippets["byKind"]> = {}): QuoteFieldSnippets => ({
    available: true,
    byKind: {
      conditions: [{ id: "c1", name: "Condiciones estándar", body: "Valores sin IVA." }],
      exclusions: [
        { id: "e1", name: "Sin embalaje", body: "No incluye embalaje." },
        { id: "e2", name: "Sin peajes", body: "No incluye peajes." },
      ],
      footer_note: [{ id: "n1", name: "Pie estándar", body: "Valores en pesos chilenos." }],
      ...over,
    },
  });
  const trigger = (label: string) =>
    host.querySelector<HTMLButtonElement>(
      `button[aria-label="Insertar texto guardado en ${label}"]`,
    );
  const menuItems = () =>
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  async function openMenu(label: string) {
    await act(async () => {
      trigger(label)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("el editor muestra los cuatro textos en el orden del PDF, cada uno opcional y con su contador", async () => {
    await mount([newFreeLine("a")], RULES);
    const labels = Array.from(host.querySelectorAll("label"))
      .map((label) => label.textContent ?? "")
      .filter((text) =>
        /^(Observaciones|Condiciones comerciales|Exclusiones|Notas al pie)/.test(text),
      );
    expect(labels).toEqual([
      "Observaciones (opcional)",
      "Condiciones comerciales (opcional)",
      "Exclusiones (opcional)",
      "Notas al pie (opcional)",
    ]);
    for (const id of ["observations", "conditions", "exclusions", "footer-note"]) {
      expect(byId(id)).not.toBeNull();
      expect(testId(`${id}-count`)!.textContent).toBe("0 / 4.000");
    }
    // la pista de las condiciones ya no manda las exclusiones aquí: tienen su campo
    expect(host.textContent).toContain("Plazos y forma de pago. Solo texto.");
    expect(host.textContent).not.toContain("Plazos, forma de pago, exclusiones");
  });

  it("cada campo tiene su botón «Insertar texto guardado», menos las observaciones", async () => {
    await mount([newFreeLine("a")], RULES, { snippets: withSnippets() });
    expect(trigger("Condiciones comerciales")).not.toBeNull();
    expect(trigger("Exclusiones")).not.toBeNull();
    expect(trigger("Notas al pie")).not.toBeNull();
    expect(host.querySelectorAll('button[aria-label^="Insertar texto guardado"]')).toHaveLength(3);
  });

  it("elegir un texto lo agrega al final, separado por una línea en blanco, y cuenta los caracteres", async () => {
    await mount([newFreeLine("a")], RULES, { snippets: withSnippets() });
    await typeText(byId("exclusions"), "Lo que ya escribí.");
    await openMenu("Exclusiones");
    const items = menuItems();
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Sin embalaje"),
      expect.stringContaining("Sin peajes"),
    ]);
    await act(async () => {
      items[0].click();
    });
    expect((byId("exclusions") as unknown as HTMLTextAreaElement).value).toBe(
      "Lo que ya escribí.\n\nNo incluye embalaje.",
    );
    expect(testId("exclusions-count")!.textContent).toBe("40 / 4.000");
    // solo cambió ese campo
    expect((byId("conditions") as unknown as HTMLTextAreaElement).value).toBe("");
    expect((byId("footer-note") as unknown as HTMLTextAreaElement).value).toBe("");
  });

  it("un texto que ya está agregado queda apagado con «Ya agregado»", async () => {
    await mount([newFreeLine("a")], RULES, { snippets: withSnippets() });
    await typeText(byId("exclusions"), "No incluye embalaje.");
    await openMenu("Exclusiones");
    const [embalaje, peajes] = menuItems();
    expect(embalaje.getAttribute("data-disabled")).not.toBeNull();
    expect(embalaje.textContent).toContain("Ya agregado");
    expect(peajes.getAttribute("data-disabled")).toBeNull();
  });

  it("un texto que haría pasar del máximo queda apagado y dice cuánto quedaría", async () => {
    await mount([newFreeLine("a")], RULES, { snippets: withSnippets() });
    await typeText(byId("exclusions"), "x".repeat(3_990));
    await openMenu("Exclusiones");
    const [embalaje] = menuItems();
    expect(embalaje.getAttribute("data-disabled")).not.toBeNull();
    expect(embalaje.textContent).toContain("No cabe: quedaría con 4.012 caracteres (máximo 4.000)");
  });

  it("sin textos guardados lo dice, y solo ofrece Configuración a quien puede administrarlos", async () => {
    await mount([newFreeLine("a")], RULES, { snippets: NO_SNIPPETS, manageSnippetsHref: null });
    await openMenu("Notas al pie");
    expect(document.body.textContent).toContain("Aún no hay textos guardados");
    expect(document.body.textContent).toContain("El Dueño o un Administrador los crea");
    expect(document.body.querySelector('a[href*="configuracion/textos"]')).toBeNull();
  });

  it("quien administra los textos ve el enlace a Configuración", async () => {
    await mount([newFreeLine("a")], RULES, {
      snippets: NO_SNIPPETS,
      manageSnippetsHref: `/o/${TENANT_ID}/configuracion/textos`,
    });
    await openMenu("Notas al pie");
    const link = document.body.querySelector<HTMLAnchorElement>('a[href*="configuracion/textos"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain("Crear textos en Configuración");
  });

  it("si no se pudieron leer los textos, lo dice en vez de mostrarse como si no hubiera", async () => {
    await mount([newFreeLine("a")], RULES, {
      snippets: { ...NO_SNIPPETS, available: false },
    });
    await openMenu("Exclusiones");
    expect(document.body.textContent).toContain("No pudimos cargar los textos guardados");
    expect(document.body.textContent).not.toContain("Aún no hay textos guardados");
  });

  it("un texto más largo que el máximo marca el campo con su mensaje y no deja guardar", async () => {
    await mount([newFreeLine("a")], RULES);
    await typeText(byId("exclusions"), "x".repeat(4_001));
    await typeText(byId("footer-note"), "y".repeat(4_001));
    expect(host.textContent).toContain("Las exclusiones son demasiado largas");
    expect(host.textContent).toContain("Las notas son demasiado largas");
    expect(byId("exclusions").getAttribute("aria-invalid")).toBe("true");
    expect(byId("footer-note").getAttribute("aria-invalid")).toBe("true");
  });
});
