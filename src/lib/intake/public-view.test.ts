import { describe, expect, it } from "vitest";
import { buildConsentNotice } from "./consent-notice";
import { buildPublicContent, buildPublicView, buildUnavailableView } from "./public-view";
import type { IntakeFormAvailable } from "./read-model";

const TENANT = "11111111-1111-4111-8111-111111111111";
const FORM = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const CATALOG = "44444444-4444-4444-8444-444444444444";

/** Lo que el servidor recibe de la base, más campos «peligrosos» que alguien podría agregar sin querer. */
const form = {
  state: "ok",
  tenantId: TENANT,
  formId: FORM,
  title: "Pide tu cotización",
  organization: {
    name: "Empresa Ficticia",
    email: "contacto@ejemplo.test",
    phone: "+56 2 2345 6789",
  },
  primaryColor: "#2B54E0",
  secondaryColor: null,
  logoPath: `${TENANT}/logo-ab12cd34ef56.png`,
  revision: 5,
  intro: "Cuéntanos qué necesitas",
  successMessage: "Gracias",
  fields: {
    phone: "optional",
    company: "off",
    comuna: "off",
    serviceAddress: "off",
    desiredDate: "off",
    message: "optional",
  },
  privacyPolicyUrl: null,
  items: [
    {
      id: ITEM,
      name: "Flete urbano",
      description: "Dentro de la RM",
      unit: "service",
      quantityMode: "optional",
      minQtyMilli: null,
      maxQtyMilli: null,
      // campos que NO deben salir nunca
      catalogItemId: CATALOG,
      unitPriceClp: 45000,
    },
  ],
  internalName: "Formulario interno secreto",
  dashboardOnlyField: "no salir",
} as unknown as IntakeFormAvailable;

const consent = buildConsentNotice({
  organizationName: form.organization.name,
  contactEmail: form.organization.email ?? "",
});

describe("lo que llega al navegador (lista blanca)", () => {
  const view = buildPublicView(form, consent);
  const json = JSON.stringify(view);

  it("trae lo que la pantalla necesita", () => {
    expect(view.title).toBe("Pide tu cotización");
    expect(view.revision).toBe(5);
    expect(view.items).toEqual([
      {
        id: ITEM,
        name: "Flete urbano",
        description: "Dentro de la RM",
        unit: "service",
        quantityMode: "optional",
        minQtyMilli: null,
        maxQtyMilli: null,
      },
    ]);
    expect(view.organization).toEqual({
      name: "Empresa Ficticia",
      contactEmail: "contacto@ejemplo.test",
      contactPhone: "+56 2 2345 6789",
    });
    expect(view.consentText).toContain("Tus datos los recibirá Empresa Ficticia");
    expect("logoDataUrl" in view).toBe(false);
    expect(view.brand.primary).toBe("#2b54e0");
  });

  it("no lleva la organización, el formulario, el nombre interno, el catálogo ni ningún monto", () => {
    for (const secret of [
      TENANT,
      FORM,
      CATALOG,
      "Formulario interno secreto",
      "no salir",
      "45000",
      "unitPriceClp",
      "catalogItemId",
      "tenantId",
      "formId",
      "logo-ab12cd34ef56",
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    expect(json).not.toMatch(/price|precio|clp|\$/i);
  });

  it("el único UUID que viaja es el de cada servicio, que el envío necesita", () => {
    const uuids = json.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
    expect(uuids).toEqual([ITEM]);
  });

  it("lo que se refresca al cambiar el formulario no lleva marca ni logo", () => {
    const content = buildPublicContent(form, consent);
    expect(Object.keys(content).sort()).toEqual([
      "consentText",
      "fields",
      "intro",
      "items",
      "privacyPolicyUrl",
      "revision",
      "successMessage",
      "title",
    ]);
  });

  it("un formulario en pausa solo muestra marca y contacto", () => {
    const paused = buildUnavailableView({ ...form, state: "paused" } as never);
    expect(Object.keys(paused).sort()).toEqual(["brand", "organization"]);
    expect(JSON.stringify(paused)).not.toContain(TENANT);
  });
});
