import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FIELD_MODES } from "@/lib/intake/builder-model";
import { FormView, type FormInteraction, type FormViewProps } from "./form-view";

const brand = {
  primary: "#2b54e0",
  secondary: "#0f1729",
  primaryText: "#2b54e0",
  onPrimary: "#ffffff",
  primaryTint: "#eaeefc",
};

const props: FormViewProps = {
  brand,
  organizationName: "Empresa Ficticia",
  logoSrc: null,
  title: "Pide tu cotización",
  intro: "",
  fields: { ...DEFAULT_FIELD_MODES, message: "optional" },
  items: [
    { id: "a", publicName: "Flete urbano", unit: "service", quantityMode: "none" },
    { id: "b", publicName: "Traslado", unit: "km", quantityMode: "required" },
  ],
  consentText: "Tus datos los recibirá Empresa Ficticia (contacto@ejemplo.test).",
  privacyPolicyUrl: null,
  idPrefix: "pf",
};

const interaction = (overrides: Partial<FormInteraction> = {}): FormInteraction => ({
  values: {
    name: "Ana <b>Prueba</b>",
    email: "ana@cliente.test",
    phone: "",
    company: "",
    comuna: "",
    serviceAddress: "",
    desiredDate: "",
    message: "Hola\n<script>alert(1)</script>",
  },
  onValueChange: vi.fn(),
  picked: { b: "12" },
  onToggleItem: vi.fn(),
  onQuantityChange: vi.fn(),
  consent: true,
  onConsentChange: vi.fn(),
  errors: {},
  submitting: false,
  onSubmit: vi.fn(),
  ...overrides,
});

const render = (overrides: Partial<FormInteraction> = {}) =>
  renderToStaticMarkup(<FormView {...props} interaction={interaction(overrides)} />);

describe("FormView en modo interactivo (página pública)", () => {
  it("muestra lo escrito como TEXTO (escapado) y los servicios elegidos", () => {
    const html = render();
    expect(html).toContain("Ana &lt;b&gt;Prueba&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<b>Prueba</b>");
    // el servicio con cantidad está marcado y trae su cantidad
    expect(html).toMatch(/id="pf-item-b"[^>]*checked/);
    expect(html).not.toMatch(/id="pf-item-a"[^>]*checked/);
    expect(html).toContain('value="12"');
  });

  it("no tiene dónde mostrar un monto", () => {
    const html = render();
    expect(html).not.toContain("$");
    expect(html).not.toMatch(/precio|price/i);
  });

  it("los errores salen junto a su campo, con role alert y aria-invalid", () => {
    const html = render({
      errors: {
        email: "Escribe un correo válido.",
        "item:b": "Escribe la cantidad.",
        items: "Elige al menos un servicio.",
        consent: "Para enviar tienes que aceptar el aviso de privacidad.",
      },
    });
    for (const message of [
      "Escribe un correo válido.",
      "Escribe la cantidad.",
      "Elige al menos un servicio.",
      "Para enviar tienes que aceptar el aviso de privacidad.",
    ]) {
      expect(html).toContain(message);
    }
    expect(html.match(/role="alert"/g)?.length).toBe(4);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="pf-email-error"');
  });

  it("el botón de enviar es de tipo submit y se bloquea mientras envía", () => {
    expect(render()).toMatch(/<button type="submit"/);
    const sending = render({ submitting: true });
    expect(sending).toContain("Enviando…");
    expect(sending).toMatch(/<button type="submit"[^>]*disabled/);
  });

  it("deja un lugar para la verificación anti-robot y los avisos justo antes del botón", () => {
    const html = render({ beforeSubmit: <div data-testid="antes">verificación</div> });
    expect(html.indexOf("verificación")).toBeGreaterThan(-1);
    expect(html.indexOf("verificación")).toBeLessThan(html.indexOf('data-testid="submit-request"'));
  });

  it("sin interacción sigue siendo la vista previa inerte", () => {
    const html = renderToStaticMarkup(<FormView {...props} preview />);
    expect(html).toContain("inert");
    expect(html).toMatch(/<button type="button"/);
  });
});
