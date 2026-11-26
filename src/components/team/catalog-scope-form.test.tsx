// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// La sección «Servicios que puede cotizar» de la ficha (H-042). La acción del servidor se reemplaza: aquí se mira lo que ve y puede hacer
// quien administra el equipo, no el guardado.
const mocks = vi.hoisted(() => ({ saveCatalogScopeAction: vi.fn(), toastSuccess: vi.fn() }));
vi.mock("@/lib/team/catalog-scope-actions", () => ({
  saveCatalogScopeAction: mocks.saveCatalogScopeAction,
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }));

import {
  CATALOG_SCOPE_UNCHANGED_MESSAGE,
  EMPTY_LIST_MESSAGE,
  NO_CATALOG_SCOPE,
  type CatalogScopeRecord,
  type ScopeCatalogItem,
} from "@/lib/team/catalog-scope-model";
import { CatalogScopeForm } from "./catalog-scope-form";

const TENANT = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const item = (n: number, name: string, isActive = true): ScopeCatalogItem => ({
  id: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
  name,
  unitLabel: "servicio",
  unitPriceClp: 10_000 * n,
  isActive,
});
const FLETE = item(1, "Flete local");
const GRUA = item(2, "Grúa");
const MUDANZA = item(3, "Mudanza");
const VIEJO = item(4, "Servicio viejo", false);
const CATALOG = [FLETE, GRUA, MUDANZA, VIEJO];

let host: HTMLDivElement;
let root: Root;

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const radio = (value: string) => q(`catalog-scope-mode-${value}`) as HTMLInputElement;
const rows = () => Array.from(host.querySelectorAll<HTMLLabelElement>("li label"));
const checkboxes = () =>
  Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
const save = () => q("catalog-scope-save") as HTMLButtonElement;
const text = (id: string) => q(id)?.textContent ?? "";

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}
async function typeSearch(value: string) {
  await act(async () => {
    const input = q("catalog-scope-search") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    (q("catalog-scope-form") as HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}
async function mount(
  initial: CatalogScopeRecord = NO_CATALOG_SCOPE,
  catalog: ScopeCatalogItem[] = CATALOG,
  extra: { catalogTruncated?: boolean } = {},
) {
  await act(async () => {
    root.render(
      createElement(CatalogScopeForm, {
        tenantId: TENANT,
        memberId: MEMBER,
        memberName: "Carla",
        initial,
        catalog,
        ...extra,
      }),
    );
  });
}
const rule = (over: Partial<CatalogScopeRecord>): CatalogScopeRecord => ({
  ...NO_CATALOG_SCOPE,
  ...over,
});

beforeEach(() => {
  mocks.saveCatalogScopeAction.mockReset();
  mocks.toastSuccess.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("cómo se ve la regla", () => {
  it("sin regla: «todos», la frase lo dice, no hay lista ni nada que guardar", async () => {
    await mount();
    expect(text("catalog-scope-summary")).toBe("Carla puede cotizar todos los servicios");
    expect(radio("all").checked).toBe(true);
    expect(radio("list").checked).toBe(false);
    expect(q("catalog-scope-picker")).toBeNull();
    expect(save().disabled).toBe(true);
    expect(text("catalog-scope-hand-written")).toBe("Las líneas escritas a mano no se limitan.");
    expect(q("catalog-scope-changed")).toBeNull();
  });

  it("con lista: la frase nombra los servicios activos, el contador, el desactivado aparte y «Cambiado por»", async () => {
    await mount(
      rule({
        mode: "list",
        revision: 2,
        itemIds: [FLETE.id, GRUA.id, VIEJO.id],
        updatedByName: "Ana",
        updatedAt: "2026-11-20T15:00:00Z",
      }),
    );
    expect(text("catalog-scope-summary")).toBe(
      "Carla puede cotizar 2 servicios: Flete local y Grúa",
    );
    expect(radio("list").checked).toBe(true);
    expect(text("catalog-scope-count")).toBe("2 de 3 elegidos");
    expect(text("catalog-scope-changed")).toBe("Cambiado por Ana el 20-11-2026");
    expect(text("catalog-scope-inactive")).toContain(
      "Desactivados en el catálogo (no se pueden cotizar)",
    );
    expect(text("catalog-scope-inactive")).toContain("Servicio viejo");
    // el desactivado marcado se puede quitar; los activos están en su propia lista
    expect(rows()).toHaveLength(4);
  });

  it("las dos opciones traen su explicación", async () => {
    await mount();
    expect(host.textContent).toContain("Incluye los que agregues después.");
    expect(host.textContent).toContain("Los servicios nuevos no se suman solos.");
  });

  it("un catálogo sin servicios activos lo dice, con enlace al catálogo, y no deja elegir «Solo los que elijas»", async () => {
    await mount(NO_CATALOG_SCOPE, [VIEJO]);
    expect(q("catalog-scope-empty")?.textContent).toContain(
      "Tu catálogo no tiene servicios activos",
    );
    expect(host.querySelector('a[href$="/catalogo"]')).not.toBeNull();
    expect(radio("list").disabled).toBe(true);
  });

  it("un catálogo largo avisa que se mostraron los primeros", async () => {
    await mount(rule({ mode: "list", revision: 1, itemIds: [FLETE.id] }), CATALOG, {
      catalogTruncated: true,
    });
    expect(host.textContent).toContain(
      "Se muestran solo los primeros 1.000 servicios del catálogo",
    );
  });
});

describe("elegir servicios", () => {
  it("«Solo los que elijas» abre el buscador y la lista; sin elegir nada avisa y no deja guardar", async () => {
    await mount();
    await click(radio("list"));
    expect(q("catalog-scope-picker")).not.toBeNull();
    expect(text("catalog-scope-count")).toBe("0 de 3 elegidos");
    expect(text("catalog-scope-problem")).toBe(EMPTY_LIST_MESSAGE);
    expect(save().disabled).toBe(true);
    // los activos, sin el desactivado
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Flete local"),
      expect.stringContaining("Grúa"),
      expect.stringContaining("Mudanza"),
    ]);
    // el precio y la unidad con el formato de Chile
    expect(rows()[0].textContent).toContain("$10.000");
  });

  it("marcar habilita «Guardar» y cuenta; el buscador filtra sin perder lo marcado", async () => {
    await mount();
    await click(radio("list"));
    await click(checkboxes()[0]);
    expect(text("catalog-scope-count")).toBe("1 de 3 elegidos");
    expect(save().disabled).toBe(false);
    await typeSearch("gru");
    expect(rows()).toHaveLength(1);
    await typeSearch("zzz");
    expect(text("catalog-scope-list")).toContain("Ningún servicio coincide con esa búsqueda.");
    await typeSearch("");
    expect(checkboxes()[0].checked).toBe(true);
    expect(text("catalog-scope-count")).toBe("1 de 3 elegidos");
  });

  it("«Marcar los que se ven» marca solo lo visible y «Desmarcar todos» limpia", async () => {
    await mount();
    await click(radio("list"));
    // «u» está en «Grúa» y «Mudanza», no en «Flete local»
    await typeSearch("u");
    await click(q("catalog-scope-select-visible")!);
    await typeSearch("");
    const checked = checkboxes().filter((box) => box.checked);
    expect(checked).toHaveLength(2);
    expect(checkboxes()[0].checked).toBe(false); // «Flete local» no se vio, no se marcó
    await click(q("catalog-scope-clear")!);
    expect(checkboxes().every((box) => !box.checked)).toBe(true);
    expect(text("catalog-scope-problem")).toBe(EMPTY_LIST_MESSAGE);
  });

  it("volver a «Todos» sin guardar deja la lista como estaba y «Guardar» queda apagado si no cambió nada", async () => {
    await mount(rule({ mode: "list", revision: 1, itemIds: [FLETE.id] }));
    expect(save().disabled).toBe(true);
    await click(radio("all"));
    expect(save().disabled).toBe(false);
    await click(radio("list"));
    expect(save().disabled).toBe(true);
    expect(checkboxes().filter((box) => box.checked)).toHaveLength(1);
  });
});

describe("guardar", () => {
  it("manda lo elegido con la versión que vio, avisa y actualiza la frase y «Cambiado por ti»", async () => {
    mocks.saveCatalogScopeAction.mockResolvedValue({
      status: "ok",
      result: "changed",
      revision: 1,
      mode: "list",
      count: 2,
    });
    await mount();
    await click(radio("list"));
    await click(checkboxes()[0]);
    await click(checkboxes()[1]);
    await submit();
    expect(mocks.saveCatalogScopeAction).toHaveBeenCalledWith(TENANT, {
      memberId: MEMBER,
      mode: "list",
      itemIds: [FLETE.id, GRUA.id],
      expectedRevision: 0,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Listo: Carla solo puede cotizar 2 servicios.",
      expect.objectContaining({ id: expect.any(String) }),
    );
    expect(text("catalog-scope-summary")).toBe(
      "Carla puede cotizar 2 servicios: Flete local y Grúa",
    );
    expect(text("catalog-scope-changed")).toMatch(/^Cambiado por ti el \d{2}-\d{2}-\d{4}$/);
    // ya guardado: nada que guardar
    expect(save().disabled).toBe(true);
    // el siguiente guardado manda la versión nueva
    mocks.saveCatalogScopeAction.mockResolvedValue({
      status: "ok",
      result: "changed",
      revision: 2,
      mode: "list",
      count: 1,
    });
    await click(checkboxes()[1]);
    await submit();
    expect(mocks.saveCatalogScopeAction).toHaveBeenLastCalledWith(
      TENANT,
      expect.objectContaining({ expectedRevision: 1, itemIds: [FLETE.id] }),
    );
  });

  it("pasar a «Todos» manda la lista vacía", async () => {
    mocks.saveCatalogScopeAction.mockResolvedValue({
      status: "ok",
      result: "changed",
      revision: 3,
      mode: "all",
      count: 0,
    });
    await mount(rule({ mode: "list", revision: 2, itemIds: [FLETE.id] }));
    await click(radio("all"));
    await submit();
    expect(mocks.saveCatalogScopeAction).toHaveBeenCalledWith(TENANT, {
      memberId: MEMBER,
      mode: "all",
      itemIds: [],
      expectedRevision: 2,
    });
    expect(text("catalog-scope-summary")).toBe("Carla puede cotizar todos los servicios");
    expect(mocks.toastSuccess.mock.calls[0][0]).toBe(
      "Listo: Carla puede cotizar todos los servicios.",
    );
  });

  it("un error de la acción se muestra en la sección y se conserva lo elegido", async () => {
    mocks.saveCatalogScopeAction.mockResolvedValue({
      status: "error",
      kind: "conflict",
      message:
        "Otra persona cambió esta lista mientras la editabas. Recarga para ver la última versión.",
    });
    await mount();
    await click(radio("list"));
    await click(checkboxes()[0]);
    await submit();
    expect(text("catalog-scope-banner")).toContain("Otra persona cambió esta lista");
    expect(checkboxes()[0].checked).toBe(true);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(save().disabled).toBe(false);
  });

  it("si la conexión falla, lo dice y conserva lo elegido", async () => {
    mocks.saveCatalogScopeAction.mockRejectedValue(new Error("network"));
    await mount();
    await click(radio("list"));
    await click(checkboxes()[0]);
    await submit();
    expect(text("catalog-scope-banner")).toContain("No pudimos comunicarnos con el servidor");
    expect(checkboxes()[0].checked).toBe(true);
  });

  it("sin conexión, «Guardar» queda apagado y no se envía", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      await mount();
      await click(radio("list"));
      await click(checkboxes()[0]);
      expect(save().disabled).toBe(true);
      await submit();
      expect(mocks.saveCatalogScopeAction).not.toHaveBeenCalled();
    } finally {
      online.mockRestore();
    }
  });

  it("«ya estaba guardado» (un doble clic) avisa que no había cambios", async () => {
    mocks.saveCatalogScopeAction.mockResolvedValue({
      status: "ok",
      result: "unchanged",
      revision: 1,
      mode: "list",
      count: 1,
    });
    await mount();
    await click(radio("list"));
    await click(checkboxes()[0]);
    await submit();
    expect(mocks.toastSuccess.mock.calls[0][0]).toBe("No había cambios que guardar.");
  });
});

describe("revisión Opus del PR 2", () => {
  it("I-2: Enter en el buscador no guarda la lista (ni con una lista a medias)", async () => {
    await mount();
    await click(radio("list"));
    await click(checkboxes()[0]);
    const search = q("catalog-scope-search") as HTMLInputElement;
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      search.dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(true);
    expect(mocks.saveCatalogScopeAction).not.toHaveBeenCalled();
    // otra tecla no se toca
    const letter = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    await act(async () => {
      search.dispatchEvent(letter);
    });
    expect(letter.defaultPrevented).toBe(false);
  });

  it("M-2: un servicio desactivado desmarcado sigue en su grupo para poder volver a marcarlo", async () => {
    await mount(rule({ mode: "list", revision: 1, itemIds: [FLETE.id, VIEJO.id] }));
    const inactiveBox = () =>
      host.querySelector<HTMLInputElement>('[data-testid="catalog-scope-inactive"] input');
    expect(inactiveBox()?.checked).toBe(true);
    await click(inactiveBox()!);
    expect(inactiveBox()).not.toBeNull();
    expect(inactiveBox()!.checked).toBe(false);
    await click(inactiveBox()!);
    expect(inactiveBox()!.checked).toBe(true);
  });

  it("M-1: con un catálogo cortado avisa cuántos se muestran y cuántos elegidos no se ven", async () => {
    const ghost = "99999999-9999-4999-8999-999999999999";
    await mount(rule({ mode: "list", revision: 1, itemIds: [FLETE.id, ghost] }), CATALOG, {
      catalogTruncated: true,
    });
    const note = text("catalog-scope-truncated");
    expect(note).toContain(
      "Se muestran solo los primeros 1.000 servicios del catálogo, por nombre",
    );
    expect(note).toContain("Hay 1 servicio elegido que no se ve aquí y cuenta en el máximo.");
  });

  it("M-1: sin elegidos escondidos, el aviso no los menciona", async () => {
    await mount(rule({ mode: "list", revision: 1, itemIds: [FLETE.id] }), CATALOG, {
      catalogTruncated: true,
    });
    expect(text("catalog-scope-truncated")).not.toContain("no se ve");
  });

  it("M-8: «ya estaba guardado» usa el texto común", async () => {
    mocks.saveCatalogScopeAction.mockResolvedValue({
      status: "ok",
      result: "unchanged",
      revision: 1,
      mode: "list",
      count: 1,
    });
    await mount();
    await click(radio("list"));
    await click(checkboxes()[0]);
    await submit();
    expect(mocks.toastSuccess.mock.calls[0][0]).toBe(CATALOG_SCOPE_UNCHANGED_MESSAGE);
  });
});
