import { resolvePdfBrand } from "@/lib/pdf/brand-colors";
import type { PdfBrand } from "@/lib/pdf/types";
import type { ConsentNotice } from "./consent-notice";
import type { FieldModes, QuantityMode } from "./field-modes";
import type {
  IntakeFormAvailable,
  IntakeFormInternal,
  IntakeOrganizationContact,
} from "./read-model";

/**
 * LISTA BLANCA de lo que llega al navegador de quien llena un formulario público. Cada campo se copia
 * por su nombre: nada se pasa «en bloque», así que un campo nuevo que agregue la base (identificadores
 * internos, nombre interno del formulario, servicio del catálogo, montos…) no sale al público por
 * accidente. Nunca van `tenant_id`, `form_id`, el nombre interno, `catalog_item_id` ni ningún monto.
 * El único identificador que viaja es el de cada servicio del formulario, que el envío necesita.
 */

export type PublicFormItem = {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  quantityMode: QuantityMode;
  minQtyMilli: number | null;
  maxQtyMilli: number | null;
};

/** Lo que cambia cuando el administrador edita el formulario (se puede refrescar sin recargar la página). */
export type PublicFormContent = {
  revision: number;
  title: string;
  intro: string;
  successMessage: string;
  fields: FieldModes;
  items: PublicFormItem[];
  /** Texto exacto del aviso de privacidad que se muestra junto a la casilla. */
  consentText: string;
  privacyPolicyUrl: string | null;
};

export type PublicOrganization = {
  name: string;
  contactEmail: string | null;
  contactPhone: string | null;
};

export type PublicFormView = PublicFormContent & {
  organization: PublicOrganization;
  brand: PdfBrand;
  /** Logo como dirección `data:` (la página pública no habla con Storage ni expone la organización). */
  logoDataUrl: string | null;
};

export function publicOrganization(contact: IntakeOrganizationContact): PublicOrganization {
  return { name: contact.name, contactEmail: contact.email, contactPhone: contact.phone };
}

export function buildPublicContent(
  form: IntakeFormAvailable,
  consent: ConsentNotice,
): PublicFormContent {
  return {
    revision: form.revision,
    title: form.title,
    intro: form.intro,
    successMessage: form.successMessage,
    fields: {
      phone: form.fields.phone,
      company: form.fields.company,
      comuna: form.fields.comuna,
      serviceAddress: form.fields.serviceAddress,
      desiredDate: form.fields.desiredDate,
      message: form.fields.message,
    },
    items: form.items.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      unit: item.unit,
      quantityMode: item.quantityMode,
      minQtyMilli: item.minQtyMilli,
      maxQtyMilli: item.maxQtyMilli,
    })),
    consentText: consent.text,
    privacyPolicyUrl: consent.privacyPolicyUrl,
  };
}

export function buildPublicView(
  form: IntakeFormAvailable,
  consent: ConsentNotice,
  logoDataUrl: string | null,
): PublicFormView {
  return {
    ...buildPublicContent(form, consent),
    organization: publicOrganization(form.organization),
    brand: resolvePdfBrand(form.primaryColor, form.secondaryColor),
    logoDataUrl,
  };
}

/** Marca y contacto de una organización cuyo formulario no está disponible (en pausa). */
export function buildUnavailableView(form: IntakeFormInternal): {
  organization: PublicOrganization;
  brand: PdfBrand;
} {
  return {
    organization: publicOrganization(form.organization),
    brand: resolvePdfBrand(form.primaryColor, form.secondaryColor),
  };
}
