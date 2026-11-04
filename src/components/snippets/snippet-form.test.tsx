// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createSnippetAction: vi.fn(),
  updateSnippetAction: vi.fn(),
  deleteSnippetAction: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("@/lib/snippets/actions", () => ({
  createSnippetAction: mocks.createSnippetAction,
  updateSnippetAction: mocks.updateSnippetAction,
  deleteSnippetAction: mocks.deleteSnippetAction,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));

import { SnippetForm, type EditableSnippet } from "./snippet-form";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const SNIPPET_ID = "22222222-2222-4222-8222-222222222222";
const LIST_HREF = `/o/${TENANT_ID}/configuracion/textos`;

let host: HTMLDivElement;
let root: Root;

const byTestId = <T extends HTMLElement>(id: string) =>
  host.querySelector<T>(`[data-testid="${id}"]`);
const kindSelect = () => byTestId<HTMLSelectElement>("snippet-kind")!;
const nameInput = () => byTestId<HTMLInputElement>("snippet-name")!;
const bodyInput = () => byTestId<HTMLTextAreaElement>("snippet-body")!;
const counter = () => byTestId("snippet-counter")!;
const form = () => byTestId<HTMLFormElement>("snippet-form")!;

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(kind: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
      kindSelect(),
      kind,
    );
    kindSelect().dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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
  document.body.innerHTML = "";
});

async function mountCreate() {
  await act(async () => {
    root.render(
      createElement(SnippetForm, {
        mode: "create",
        tenantId: TENANT_ID,
        snippetId: SNIPPET_ID,
        listHref: LIST_HREF,
      }),
    );
  });
}
const EXISTING: EditableSnippet = {
  id: SNIPPET_ID,
  kind: "email_body",
  name: "Saludo",
  body: "Estimado {{cliente}}",
  isDefault: false,
  revision: 4,
};
async function mountEdit(snippet: EditableSnippet = EXISTING) {
  await act(async () => {
    root.render(
      createElement(SnippetForm, {
        mode: "edit",
        tenantId: TENANT_ID,
        snippet,
        listHref: LIST_HREF,
      }),
    );
  });
}

describe("SnippetForm · crear", () => {
  it("las variables, la vista previa y la casilla del texto inicial solo aparecen en el texto del correo", async () => {
    await mountCreate();
    expect(byTestId("snippet-variables")).toBeNull();
    expect(byTestId("snippet-default")).toBeNull();
    expect(byTestId("snippet-preview")).toBeNull();

    await choose("email_body");
    expect(byTestId("snippet-variables")).not.toBeNull();
    expect(byTestId("snippet-default")).not.toBeNull();
    expect(byTestId("snippet-preview")).not.toBeNull();
    for (const variable of ["cliente", "numero", "remitente", "organizacion"]) {
      expect(byTestId(`snippet-variable-${variable}`)).not.toBeNull();
    }

    await choose("conditions");
    expect(byTestId("snippet-variables")).toBeNull();
    expect(byTestId("snippet-default")).toBeNull();
    expect(byTestId("snippet-preview")).toBeNull();
  });

  it("al cambiar a otro tipo se desmarca el texto inicial", async () => {
    mocks.createSnippetAction.mockResolvedValue({
      status: "ok",
      outcome: "created",
      message: "Guardamos el texto.",
    });
    await mountCreate();
    await choose("email_body");
    await click(byTestId("snippet-default")!);
    await choose("exclusions");
    await typeInto(nameInput(), "No incluye embalaje");
    await typeInto(bodyInput(), "No incluye embalaje.");
    await submit();
    expect(mocks.createSnippetAction).toHaveBeenCalledWith(TENANT_ID, {
      id: SNIPPET_ID,
      kind: "exclusions",
      name: "No incluye embalaje",
      body: "No incluye embalaje.",
      isDefault: false,
    });
  });

  it("el contador cuenta los caracteres y se marca cuando pasa de 4.000", async () => {
    await mountCreate();
    expect(counter().textContent).toBe("0 / 4.000");
    await typeInto(bodyInput(), "Hola");
    expect(counter().textContent).toBe("4 / 4.000");
    expect(counter().className).not.toContain("text-danger");
    await typeInto(bodyInput(), "a".repeat(4001));
    expect(counter().textContent).toBe("4.001 / 4.000");
    expect(counter().className).toContain("text-danger");
  });

  it("un texto demasiado largo no se envía: se avisa bajo el campo", async () => {
    await mountCreate();
    await choose("conditions");
    await typeInto(nameInput(), "Largo");
    await typeInto(bodyInput(), "a".repeat(4001));
    await submit();
    expect(mocks.createSnippetAction).not.toHaveBeenCalled();
    expect(host.textContent).toContain("El texto es demasiado largo");
  });

  it("sin tipo, nombre ni texto avisa de cada uno y no llama al servidor", async () => {
    await mountCreate();
    await submit();
    expect(mocks.createSnippetAction).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Elige el tipo de texto.");
    expect(host.textContent).toContain("Escribe un nombre para el texto.");
    expect(host.textContent).toContain("Escribe el texto.");
  });

  it("una variable que no existe se avisa antes de enviar", async () => {
    await mountCreate();
    await choose("email_body");
    await typeInto(nameInput(), "Saludo");
    await typeInto(bodyInput(), "Hola {{telefono}}");
    await submit();
    expect(mocks.createSnippetAction).not.toHaveBeenCalled();
    expect(host.textContent).toContain("variable que no existe");
  });

  it("al guardar muestra el aviso y vuelve a la lista", async () => {
    mocks.createSnippetAction.mockResolvedValue({
      status: "ok",
      outcome: "created",
      message: "Guardamos el texto.",
      id: SNIPPET_ID,
      revision: 1,
    });
    await mountCreate();
    await choose("conditions");
    await typeInto(nameInput(), "  Pago a 30 días ");
    await typeInto(bodyInput(), "Pago a 30 días.");
    await submit();
    expect(mocks.createSnippetAction).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Guardamos el texto.", expect.anything());
    expect(mocks.push).toHaveBeenCalledWith(LIST_HREF);
  });

  it("un doble clic no envía dos veces mientras la primera respuesta no llega", async () => {
    let resolve!: (value: unknown) => void;
    mocks.createSnippetAction.mockReturnValue(new Promise((r) => (resolve = r)));
    await mountCreate();
    await choose("conditions");
    await typeInto(nameInput(), "Pago");
    await typeInto(bodyInput(), "Pago a 30 días.");
    await submit();
    await submit();
    expect(mocks.createSnippetAction).toHaveBeenCalledTimes(1);
    expect(byTestId("snippet-save")!.textContent).toContain("Guardando…");
    await act(async () =>
      resolve({ status: "ok", outcome: "created", message: "Guardamos el texto." }),
    );
  });

  it("un fallo de red se muestra en la misma pantalla y lo escrito no se pierde", async () => {
    mocks.createSnippetAction.mockRejectedValue(new TypeError("Failed to fetch"));
    await mountCreate();
    await choose("conditions");
    await typeInto(nameInput(), "Pago");
    await typeInto(bodyInput(), "Pago a 30 días.");
    await submit();
    expect(byTestId("snippet-error")!.textContent).toContain("No pudimos conectar con el servidor");
    expect(nameInput().value).toBe("Pago");
    expect(bodyInput().value).toBe("Pago a 30 días.");
    expect(mocks.push).not.toHaveBeenCalled();
    // y se puede volver a intentar
    mocks.createSnippetAction.mockResolvedValue({
      status: "ok",
      outcome: "created",
      message: "Guardamos el texto.",
    });
    await submit();
    expect(mocks.push).toHaveBeenCalledWith(LIST_HREF);
    expect(byTestId("snippet-error")).toBeNull();
  });

  it("un problema del nombre que responde el servidor se muestra bajo el nombre", async () => {
    mocks.createSnippetAction.mockResolvedValue({
      status: "error",
      kind: "invalid",
      message: "Ya tienes un texto con ese nombre en este tipo. Elige otro nombre.",
      fieldErrors: { name: "Ya tienes un texto con ese nombre en este tipo. Elige otro nombre." },
    });
    await mountCreate();
    await choose("conditions");
    await typeInto(nameInput(), "Pago");
    await typeInto(bodyInput(), "Pago a 30 días.");
    await submit();
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain("Ya tienes un texto con ese nombre");
    expect(byTestId("snippet-error")).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe("SnippetForm · el texto del correo", () => {
  it("el botón inserta la variable donde está el cursor y deja el cursor después de ella", async () => {
    await mountCreate();
    await choose("email_body");
    await typeInto(bodyInput(), "Hola , gracias");
    bodyInput().setSelectionRange(5, 5);
    await click(byTestId("snippet-variable-cliente")!);
    expect(bodyInput().value).toBe("Hola {{cliente}}, gracias");
    expect(bodyInput().selectionStart).toBe(5 + "{{cliente}}".length);
    expect(bodyInput().selectionEnd).toBe(5 + "{{cliente}}".length);
    expect(document.activeElement).toBe(bodyInput());
    expect(counter().textContent).toBe("25 / 4.000");
  });

  it("si hay texto seleccionado, la variable lo reemplaza", async () => {
    await mountCreate();
    await choose("email_body");
    await typeInto(bodyInput(), "Hola NOMBRE, gracias");
    bodyInput().setSelectionRange(5, 11);
    await click(byTestId("snippet-variable-numero")!);
    expect(bodyInput().value).toBe("Hola {{numero}}, gracias");
  });

  it("la vista previa completa las variables con datos de ejemplo", async () => {
    await mountCreate();
    await choose("email_body");
    expect(byTestId("snippet-preview")!.textContent).toContain(
      "Escribe el texto para ver cómo quedará.",
    );
    await typeInto(
      bodyInput(),
      "Estimado {{cliente}}:\n\nCotización {{numero}}.\n\nSaludos,\n{{remitente}}, {{organizacion}}",
    );
    const text = byTestId("snippet-preview-text")!.textContent;
    expect(text).toBe(
      "Estimado Ana Pérez:\n\nCotización COT-2026-0001.\n\nSaludos,\nJuan Soto, Tu Empresa SpA",
    );
    expect(text).not.toContain("{{");
  });

  it("la vista previa avisa si el texto no se podría enviar (enlace engañoso)", async () => {
    await mountCreate();
    await choose("email_body");
    await typeInto(bodyInput(), "Mira [www.banco.cl](https://malo.ejemplo/entrar)");
    expect(byTestId("snippet-preview-problem")!.textContent).toContain("enlace");
  });

  it("un correo con enlace engañoso no se envía: se avisa bajo el campo y lo escrito se conserva", async () => {
    await mountCreate();
    await choose("email_body");
    await typeInto(nameInput(), "Saludo");
    await typeInto(bodyInput(), "Mira [www.banco.cl](https://malo.ejemplo/entrar)");
    await submit();
    expect(mocks.createSnippetAction).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Un enlace muestra una dirección distinta");
    expect(bodyInput().getAttribute("aria-invalid")).toBe("true");
    expect(bodyInput().value).toContain("malo.ejemplo");
  });

  it("el contador queda dentro de lo que lee el lector de pantalla al entrar al campo", async () => {
    await mountCreate();
    await choose("conditions");
    const describedBy = (bodyInput().getAttribute("aria-describedby") ?? "").split(" ");
    expect(describedBy).toContain(counter().id);
    // También con un error del campo: el error y el contador van juntos.
    await submit();
    const withError = (bodyInput().getAttribute("aria-describedby") ?? "").split(" ");
    expect(withError).toContain(counter().id);
    expect(withError.length).toBe(2);
  });

  it("el error de «texto inicial» se conecta a la casilla", async () => {
    mocks.createSnippetAction.mockResolvedValue({
      status: "error",
      kind: "invalid",
      message: "Solo un texto del correo puede ser el texto inicial.",
      fieldErrors: { isDefault: "Solo un texto del correo puede ser el texto inicial." },
    });
    await mountCreate();
    await choose("email_body");
    await typeInto(nameInput(), "Saludo");
    await typeInto(bodyInput(), "Hola {{cliente}}");
    await click(byTestId("snippet-default")!);
    await submit();
    const checkbox = byTestId<HTMLInputElement>("snippet-default")!;
    expect(checkbox.getAttribute("aria-invalid")).toBe("true");
    const errorId = checkbox.getAttribute("aria-describedby");
    expect(errorId).toBeTruthy();
    expect(host.querySelector(`[id="${errorId}"]`)!.textContent).toContain("texto inicial");
  });

  it("si el texto ya estaba guardado, avisa y lleva a la pantalla de ese texto", async () => {
    mocks.createSnippetAction.mockResolvedValue({
      status: "ok",
      outcome: "exists",
      message: "Este texto ya estaba guardado; revisa que quedó como querías.",
      id: SNIPPET_ID,
      revision: 1,
    });
    await mountCreate();
    await choose("conditions");
    await typeInto(nameInput(), "Pago");
    await typeInto(bodyInput(), "Pago a 30 días.");
    await submit();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Este texto ya estaba guardado; revisa que quedó como querías.",
      expect.anything(),
    );
    expect(mocks.push).toHaveBeenCalledWith(`${LIST_HREF}/${SNIPPET_ID}`);
  });

  it("marcar como texto inicial se manda al guardar", async () => {
    mocks.createSnippetAction.mockResolvedValue({
      status: "ok",
      outcome: "created",
      message: "Guardamos el texto.",
    });
    await mountCreate();
    await choose("email_body");
    await typeInto(nameInput(), "Saludo");
    await typeInto(bodyInput(), "Hola {{cliente}}");
    await click(byTestId("snippet-default")!);
    await submit();
    expect(mocks.createSnippetAction).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ kind: "email_body", isDefault: true }),
    );
  });
});

describe("SnippetForm · editar", () => {
  it("muestra el tipo sin dejar cambiarlo y parte de lo guardado", async () => {
    await mountEdit();
    expect(byTestId("snippet-kind")).toBeNull();
    expect(byTestId("snippet-kind-fixed")!.textContent).toBe("Texto del correo");
    expect(nameInput().value).toBe("Saludo");
    expect(bodyInput().value).toBe("Estimado {{cliente}}");
    expect(byTestId("snippet-preview")).not.toBeNull();
  });

  it("guarda con la revisión que vio y la siguiente vez usa la nueva", async () => {
    mocks.updateSnippetAction
      .mockResolvedValueOnce({
        status: "ok",
        outcome: "updated",
        message: "Guardamos los cambios.",
        id: SNIPPET_ID,
        revision: 5,
      })
      .mockResolvedValueOnce({
        status: "ok",
        outcome: "updated",
        message: "Guardamos los cambios.",
        id: SNIPPET_ID,
        revision: 6,
      });
    await mountEdit();
    await typeInto(nameInput(), "Saludo nuevo");
    await submit();
    expect(mocks.updateSnippetAction).toHaveBeenLastCalledWith(TENANT_ID, {
      id: SNIPPET_ID,
      expectedRevision: 4,
      name: "Saludo nuevo",
      body: "Estimado {{cliente}}",
      isDefault: false,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Guardamos los cambios.", expect.anything());
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    await typeInto(nameInput(), "Saludo otra vez");
    await submit();
    expect(mocks.updateSnippetAction).toHaveBeenLastCalledWith(
      TENANT_ID,
      expect.objectContaining({ expectedRevision: 5 }),
    );
  });

  it("si otra persona guardó antes, avisa, no pierde lo escrito y ofrece recargar", async () => {
    mocks.updateSnippetAction.mockResolvedValue({
      status: "error",
      kind: "conflict",
      message:
        "Otra persona cambió este texto mientras lo editabas. Recarga para ver la versión actual.",
    });
    await mountEdit();
    await typeInto(bodyInput(), "Mi cambio");
    await submit();
    expect(byTestId("snippet-error")!.textContent).toContain("Otra persona cambió este texto");
    expect(bodyInput().value).toBe("Mi cambio");
    await click(byTestId("snippet-reload")!);
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("un fallo de red al editar se avisa en la pantalla", async () => {
    mocks.updateSnippetAction.mockRejectedValue(new TypeError("Failed to fetch"));
    await mountEdit();
    await typeInto(bodyInput(), "Mi cambio");
    await submit();
    expect(byTestId("snippet-error")!.textContent).toContain("No pudimos conectar con el servidor");
    expect(bodyInput().value).toBe("Mi cambio");
  });

  it("eliminar pide confirmar, explica que las cotizaciones no cambian y vuelve a la lista", async () => {
    mocks.deleteSnippetAction.mockResolvedValue({
      status: "ok",
      outcome: "deleted",
      message: "Eliminamos el texto.",
    });
    await mountEdit();
    await click(byTestId("snippet-delete-button")!);
    const dialog = document.querySelector('[data-testid="snippet-delete-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("¿Eliminar este texto?");
    expect(dialog!.textContent).toContain("Las cotizaciones ya creadas no cambian.");
    expect(mocks.deleteSnippetAction).not.toHaveBeenCalled();
    await click(document.querySelector<HTMLElement>('[data-testid="snippet-delete-confirm"]')!);
    expect(mocks.deleteSnippetAction).toHaveBeenCalledWith(TENANT_ID, SNIPPET_ID);
    expect(mocks.push).toHaveBeenCalledWith(LIST_HREF);
  });

  it("si eliminar falla, el diálogo sigue abierto con el motivo", async () => {
    mocks.deleteSnippetAction.mockRejectedValue(new TypeError("Failed to fetch"));
    await mountEdit();
    await click(byTestId("snippet-delete-button")!);
    await click(document.querySelector<HTMLElement>('[data-testid="snippet-delete-confirm"]')!);
    const dialog = document.querySelector('[data-testid="snippet-delete-dialog"]');
    expect(dialog!.textContent).toContain("No pudimos conectar con el servidor");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
