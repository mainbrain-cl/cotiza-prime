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
  ready: true,
  action: "/api/v1/public/forms/AAAAAAAAAAAAAAAAAAAAAA/requests",
  ...overrides,
});

const DISABLED_SUBMIT = /<button type="submit"[^>]*\sdisabled=""/;

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

  it("el formulario es method=post, ningún campo lleva name y el botón espera a que la página esté lista", () => {
    const html = render({ ready: false });
    expect(html).toMatch(/<form[^>]*method="post"/);
    expect(html).toContain('action="/api/v1/public/forms/AAAAAAAAAAAAAAAAAAAAAA/requests"');
    // sin `name`, un envío «clásico» del navegador no lleva ningún dato (ni por la dirección ni en el cuerpo)
    expect(html).not.toMatch(/<(input|textarea|select)[^>]*\sname=/);
    expect(html).toMatch(DISABLED_SUBMIT);
    expect(render({ ready: true })).not.toMatch(DISABLED_SUBMIT);
    // con JavaScript apagado se dice por qué no se puede enviar
    expect(html).toContain("<noscript>");
    expect(html).toContain("Para enviar este formulario necesitas activar JavaScript.");
  });

  it("la cantidad nombra el servicio y el enlace de privacidad queda fuera de la etiqueta de la casilla", () => {
    const html = renderToStaticMarkup(
      <FormView
        {...props}
        privacyPolicyUrl="https://ejemplo.test/privacidad"
        interaction={interaction()}
      />,
    );
    expect(html).toMatch(/Cantidad[^<]*<span class="sr-only"> de Traslado<\/span>/);
    const consentLabel = /<label for="pf-consent"[^>]*>([\s\S]*?)<\/label>/.exec(html)?.[1] ?? "";
    expect(consentLabel).toContain("Tus datos los recibirá");
    expect(consentLabel).not.toContain("<a ");
    expect(html).toContain('href="https://ejemplo.test/privacidad"');
  });

  it("solo dibuja el enlace de privacidad si es https (segunda defensa)", () => {
    for (const bad of [
      "http://ejemplo.test/privacidad",
      "javascript:alert(1)",
      "data:text/html,hola",
      "//ejemplo.test/x",
      "https://usuario:clave@ejemplo.test/x",
      "no es una dirección",
    ]) {
      const html = renderToStaticMarkup(
        <FormView {...props} privacyPolicyUrl={bad} interaction={interaction()} />,
      );
      expect(html, bad).not.toContain("Leer la política");
      expect(html, bad).not.toContain("<a ");
    }
  });

  it("el error de «ningún servicio» queda atado al grupo y el foco puede ir a él", () => {
    const html = render({ errors: { items: "Elige al menos un servicio." } });
    expect(html).toMatch(/<fieldset[^>]*aria-describedby="pf-items-error"/);
    expect(html).toContain('data-invalid-group="true"');
    expect(html).toMatch(/<fieldset[^>]*tabindex="-1"/);
    expect(render()).not.toContain("data-invalid-group");
  });

  it("el botón de enviar es de tipo submit y se bloquea mientras envía", () => {
    expect(render()).toMatch(/<button type="submit"/);
    const sending = render({ submitting: true });
    expect(sending).toContain("Enviando…");
    expect(sending).toMatch(DISABLED_SUBMIT);
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
