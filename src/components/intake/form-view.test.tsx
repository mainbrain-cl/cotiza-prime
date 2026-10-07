import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_FIELD_MODES } from "@/lib/intake/builder-model";
import { FormView, type FormViewProps } from "./form-view";

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
  intro: "Te respondemos hoy.",
  fields: { ...DEFAULT_FIELD_MODES, company: "required", message: "off" },
  items: [
    {
      id: "a",
      publicName: "Flete urbano",
      publicDescription: "Dentro de la RM",
      unit: "service",
      quantityMode: "none",
    },
    { id: "b", publicName: "Traslado", unit: "km", quantityMode: "required" },
  ],
  consentText: "Tus datos los recibirá Empresa Ficticia (contacto@ejemplo.test).",
  privacyPolicyUrl: "https://ejemplo.test/privacidad",
  preview: true,
};

describe("FormView", () => {
  const html = renderToStaticMarkup(<FormView {...props} />);

  it("usa la marca de la organización y la pantalla clara del cliente", () => {
    expect(html).toContain("customer-light");
    expect(html).toContain("--brand:#2b54e0");
    expect(html).toContain("Empresa Ficticia");
  });

  it("muestra título, introducción, servicios y el aviso de privacidad con su enlace", () => {
    expect(html).toContain("Pide tu cotización");
    expect(html).toContain("Te respondemos hoy.");
    expect(html).toContain("Flete urbano");
    expect(html).toContain("Dentro de la RM");
    expect(html).toContain("Tus datos los recibirá Empresa Ficticia");
    expect(html).toContain('href="https://ejemplo.test/privacidad"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("pide nombre y correo siempre, y respeta los modos de los demás datos", () => {
    expect(html).toContain("Nombre");
    expect(html).toContain("Correo");
    expect(html).toContain("Teléfono (opcional)");
    expect(html).toContain("Empresa");
    expect(html).not.toContain(">Mensaje");
    expect(html).not.toContain("Comuna");
  });

  it("la cantidad solo se pide donde corresponde", () => {
    expect(html.match(/Cantidad/g)?.length).toBe(1);
  });

  it("no tiene dónde mostrar un precio y la vista previa queda inerte", () => {
    expect(html).not.toContain("$");
    expect(html).not.toMatch(/precio|price/i);
    expect(html).toContain("inert");
  });

  it("sin correo de contacto avisa en vez de inventar el aviso", () => {
    const empty = renderToStaticMarkup(
      <FormView {...props} consentText={null} privacyPolicyUrl={null} />,
    );
    expect(empty).toContain("correo de contacto");
    expect(empty).not.toContain("Leer la política");
  });
});
