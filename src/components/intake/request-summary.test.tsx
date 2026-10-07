import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildStoredRequestSummary } from "@/lib/intake/stored-summary";
import { buildRequestSummary, type SummaryConfig } from "@/lib/intake/summary-model";
import { announcementFor, EMPTY_SUMMARY_TEXT, RequestSummary } from "./request-summary";

const CONFIG: SummaryConfig = {
  fields: {
    phone: "optional",
    company: "off",
    comuna: "optional",
    serviceAddress: "off",
    desiredDate: "optional",
    message: "optional",
  },
  items: [
    { id: "a", publicName: "Traslado por kilómetro", unit: "km", quantityMode: "required" },
    { id: "b", publicName: "Flete urbano", unit: "", quantityMode: "none" },
  ],
};

const html = (summary: ReturnType<typeof buildRequestSummary>, announce = false) =>
  renderToStaticMarkup(<RequestSummary summary={summary} announce={announce} />);

const visibleText = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, "|")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" / ");

describe("RequestSummary", () => {
  it("vacío: invita a llenar el formulario", () => {
    const markup = html(buildRequestSummary(CONFIG, {}));
    expect(markup).toContain(EMPTY_SUMMARY_TEXT);
  });

  it("muestra servicios con cantidad y unidad, y omite los campos vacíos", () => {
    const markup = html(
      buildRequestSummary(CONFIG, {
        name: "Ana",
        email: "ana@cliente.test",
        items: [{ formItemId: "a", quantity: "12,5" }, { formItemId: "b" }],
      }),
    );
    const text = visibleText(markup);
    expect(text).toContain("Traslado por kilómetro / 12,5 km");
    expect(text).toContain("Flete urbano");
    expect(text).toContain("Ana");
    expect(text).not.toContain("Teléfono");
    expect(text).not.toContain("Mensaje");
    expect(text).not.toContain("Detalles");
  });

  it("sin servicios elegidos pero con datos, lo dice", () => {
    expect(visibleText(html(buildRequestSummary(CONFIG, { name: "Ana" })))).toContain(
      "Sin servicios elegidos.",
    );
  });

  it("lo escrito sale como texto plano, con los caracteres escapados", () => {
    const markup = html(
      buildRequestSummary(CONFIG, {
        name: "<img src=x onerror=alert(1)>",
        message: 'Hola\n<script>alert(1)</script> & "comillas"',
      }),
    );
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).toContain("whitespace-pre-wrap");
  });

  it("nunca muestra signos ni montos de dinero", () => {
    const markup = html(
      buildRequestSummary(CONFIG, {
        name: "Ana",
        email: "ana@cliente.test",
        items: [{ formItemId: "a", quantity: "3" }],
        message: "Quiero cotizar",
      }),
    );
    expect(visibleText(markup)).not.toMatch(/[$]|CLP|precio|total|IVA/i);
  });

  it("el aviso para lectores de pantalla solo existe si se pide, y es breve", () => {
    const summary = buildRequestSummary(CONFIG, {
      name: "Ana",
      items: [{ formItemId: "a", quantity: "3" }],
    });
    expect(html(summary)).not.toContain("aria-live");
    expect(html(summary, true)).toContain('aria-live="polite"');
    expect(announcementFor(summary)).toBe("Resumen actualizado: 1 servicio elegido y 1 dato.");
    expect(announcementFor(buildRequestSummary(CONFIG, {}))).toBe("Tu resumen está vacío.");
  });

  it("el equipo ve el mismo texto que el visitante con el mismo borrador", () => {
    const visitor = buildRequestSummary(CONFIG, {
      name: "Ana Prueba",
      email: "ana@cliente.test",
      phone: "+56 9 1234 5678",
      comuna: "Ñuñoa",
      desiredDate: "2026-10-20",
      message: "Hola\nnecesito flete",
      items: [{ formItemId: "a", quantity: "12,5" }, { formItemId: "b" }],
    });
    const team = buildStoredRequestSummary({
      contact: {
        name: "Ana Prueba",
        email: "ana@cliente.test",
        phone: "+56 9 1234 5678",
        company: null,
        comuna: "Ñuñoa",
        serviceAddress: null,
        message: "Hola\nnecesito flete",
      },
      desiredDate: "2026-10-20",
      items: [
        { name: "Traslado por kilómetro", unit: "km", quantityMilli: 12_500 },
        { name: "Flete urbano", unit: "service", quantityMilli: null },
      ],
    });
    expect(visibleText(html(team))).toBe(visibleText(html(visitor)));
  });
});
