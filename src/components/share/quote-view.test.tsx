// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ShareDocument } from "@/lib/share/read-model";
import { QuoteView } from "./quote-view";
import { ShareUnavailable } from "./unavailable";

const line = {
  name: "Servicio Alfa",
  description: null,
  exempt: false,
  quantity: "1",
  unit: "servicio",
  unitPrice: "$10.000",
  discount: "—",
  total: "$10.000",
};

const doc: ShareDocument = {
  paper: "letter",
  brand: {
    primary: "#2b54e0",
    secondary: "#0f1729",
    primaryText: "#2b54e0",
    onPrimary: "#ffffff",
    primaryTint: "#eaeefc",
  },
  // Dos líneas iguales a propósito: las claves no pueden repetirse.
  organization: { name: "Empresa Ficticia", detailLines: ["Santiago", "Santiago"] },
  quote: {
    number: "COT-2026-0001",
    versionLabel: null,
    issueDate: "01-10-2026",
    validUntil: "31-10-2026",
    validityNote: null,
  },
  preparedBy: { name: "Vendedora", detailLines: ["Ventas", "Ventas"] },
  lines: [line, { ...line }],
  totals: {
    subtotal: "$20.000",
    globalDiscount: null,
    netTaxable: "$20.000",
    exempt: null,
    taxLabel: "IVA 19%",
    tax: "$3.800",
    total: "$23.800",
  },
  observations: null,
  conditions: null,
  paymentTerms: null,
};

function render(responseNotice: string | null = null) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const container = document.createElement("div");
  // Render de navegador (no de servidor): ahí React avisa de las claves repetidas.
  act(() => {
    createRoot(container).render(
      createElement(QuoteView, {
        document: doc,
        customer: { name: "Cliente Ficticio", detailLines: ["a@ejemplo.test", "a@ejemplo.test"] },
        logoDataUrl: null,
        pdfHref: "/pdf",
        responseNotice,
      }),
    );
  });
  const consoleErrors = errors.mock.calls.map((call) => String(call[0]));
  errors.mockRestore();
  return { container, consoleErrors };
}

describe("QuoteView: accesibilidad (H-030, menor 6)", () => {
  it("tiene un único h1, con el nombre de la organización", () => {
    const { container } = render();
    const headings = container.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe("Empresa Ficticia");
  });

  it("ninguna lista de definiciones tiene un párrafo adentro", () => {
    const { container } = render();
    expect(container.querySelectorAll("dl p")).toHaveLength(0);
    expect(container.querySelector('[data-testid="share-totals"]')?.textContent).toContain(
      "$23.800",
    );
    expect(container.textContent).toContain("Valores en pesos chilenos.");
  });

  it("las líneas repetidas no producen claves duplicadas", () => {
    const { consoleErrors } = render();
    expect(consoleErrors.filter((message) => /same key|unique "key"/i.test(message))).toEqual([]);
  });

  it("si el cliente ya respondió, muestra el aviso", () => {
    const { container } = render("Esta cotización ya fue aceptada el 02-10-2026.");
    expect(container.querySelector('[data-testid="share-response-notice"]')?.textContent).toBe(
      "Esta cotización ya fue aceptada el 02-10-2026.",
    );
    expect(render().container.querySelector('[data-testid="share-response-notice"]')).toBeNull();
  });
});

describe("ShareUnavailable: reemplazada", () => {
  it("avisa que hay una versión nueva y no muestra la cotización", () => {
    const html = renderToStaticMarkup(
      createElement(ShareUnavailable, {
        state: "superseded",
        contact: { name: "Empresa Ficticia", detailLines: ["x", "x"] },
      }),
    );
    expect(html).toContain("Hay una versión más nueva de esta cotización");
    expect(html).toContain("Empresa Ficticia");
    expect(html).not.toContain("share-quote");
  });
});
