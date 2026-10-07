import type { FieldMode, FieldModes, QuantityMode } from "./field-modes";

/**
 * Modelo del constructor del formulario público (H-086). Todo texto de este archivo y de los que lo
 * usan trabaja SOLO con textos: no importa nada de dinero (`@/lib/money`, `quotes/calc`, catálogo) y
 * no existe ningún campo de precio. Un servicio elegido del catálogo copia nombre, descripción y
 * unidad; el precio nunca se lee ni se copia.
 */

export const FORM_STATUSES = ["draft", "published", "paused", "archived"] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

export const FORM_STATUS_LABELS: Record<FormStatus, string> = {
  draft: "Borrador",
  published: "Publicado",
  paused: "En pausa",
  archived: "Archivado",
};

/** Mismos límites que la base (migración 29). */
export const FORM_NAME_MAX = 120;
export const FORM_TITLE_MAX = 120;
export const FORM_INTRO_MAX = 1_000;
export const FORM_SUCCESS_MAX = 500;
export const FORM_ITEM_NAME_MAX = 150;
export const FORM_ITEM_DESCRIPTION_MAX = 500;
export const FORM_ITEMS_MAX = 50;
export const FORM_POLICY_URL_MAX = 500;
/** Formularios sin archivar que puede tener una organización (el mensaje de tope lo da la base). */
export const FORMS_PER_ORGANIZATION_MAX = 20;

/**
 * La página pública `/f/[publicId]` la construye la historia H-087. Mientras no exista, el enlace se
 * muestra con una nota. Al construirla, cambiar a `true` (y la nota desaparece).
 */
export const PUBLIC_FORM_ROUTE_AVAILABLE = false;

export const FIELD_MODE_OPTIONS: readonly { value: FieldMode; label: string }[] = [
  { value: "off", label: "No pedir" },
  { value: "optional", label: "Opcional" },
  { value: "required", label: "Obligatorio" },
];

/** Datos que se pueden configurar. Nombre y correo no están: siempre se piden y son obligatorios. */
export const CONFIGURABLE_FIELDS: readonly {
  key: keyof FieldModes;
  label: string;
  hint: string;
}[] = [
  { key: "phone", label: "Teléfono", hint: "Útil si prefieres llamar para aclarar detalles." },
  { key: "company", label: "Empresa", hint: "Solo si cotizas a empresas." },
  { key: "comuna", label: "Comuna", hint: "Sirve para saber de dónde viene la solicitud." },
  {
    key: "serviceAddress",
    label: "Dirección del servicio",
    hint: "Dónde se haría el trabajo (origen, destino u obra).",
  },
  { key: "desiredDate", label: "Fecha deseada", hint: "Cuándo necesita el servicio." },
  {
    key: "message",
    label: "Mensaje",
    hint: "Un espacio para que cuente su caso con sus palabras.",
  },
];

/** Lo mínimo que sugiere el sistema para un formulario nuevo (igual que el valor de la base). */
export const DEFAULT_FIELD_MODES: FieldModes = {
  phone: "optional",
  company: "off",
  comuna: "off",
  serviceAddress: "optional",
  desiredDate: "optional",
  message: "optional",
};

export const ITEM_UNITS = [
  { value: "service", label: "Servicio" },
  { value: "hour", label: "Hora" },
  { value: "km", label: "Kilómetro" },
  { value: "m2", label: "Metro cuadrado (m²)" },
  { value: "day", label: "Día" },
  { value: "unit", label: "Unidad" },
] as const;

export type ItemUnit = (typeof ITEM_UNITS)[number]["value"];

export function itemUnitLabel(unit: string): string {
  return ITEM_UNITS.find((u) => u.value === unit)?.label ?? unit;
}

/** Unidad corta que se escribe junto a la cantidad en el resumen y en la vista previa. */
export function itemUnitShort(unit: string): string {
  switch (unit) {
    case "hour":
      return "horas";
    case "km":
      return "km";
    case "m2":
      return "m²";
    case "day":
      return "días";
    case "unit":
      return "unidades";
    default:
      return "";
  }
}

export const QUANTITY_MODE_OPTIONS: readonly { value: QuantityMode; label: string }[] = [
  { value: "none", label: "No pedir cantidad" },
  { value: "optional", label: "Cantidad opcional" },
  { value: "required", label: "Cantidad obligatoria" },
];

export type EditorItem = {
  /** Identidad del servicio dentro del formulario; la genera la pantalla y se conserva entre guardados. */
  id: string;
  kind: "catalog" | "free";
  catalogItemId: string | null;
  publicName: string;
  publicDescription: string;
  unit: ItemUnit;
  quantityMode: QuantityMode;
  /** Límites de cantidad que ya traía el formulario; esta pantalla no los edita pero los conserva. */
  minQtyMilli: number | null;
  maxQtyMilli: number | null;
};

export type EditorForm = {
  name: string;
  title: string;
  intro: string;
  successMessage: string;
  fields: FieldModes;
  /** Vacío = sin política propia. */
  privacyPolicyUrl: string;
  items: EditorItem[];
};

/** Un servicio del catálogo tal como lo ofrece el selector: SIN precio ni IVA. */
export type CatalogChoice = {
  id: string;
  name: string;
  description: string | null;
  unit: string;
};

function asUnit(unit: string): ItemUnit {
  return ITEM_UNITS.some((u) => u.value === unit) ? (unit as ItemUnit) : "service";
}

/** Copia nombre, descripción y unidad del catálogo. No toca ningún dato de precio. */
export function itemFromCatalog(choice: CatalogChoice, id: string): EditorItem {
  return {
    id,
    kind: "catalog",
    catalogItemId: choice.id,
    publicName: choice.name.slice(0, FORM_ITEM_NAME_MAX),
    publicDescription: (choice.description ?? "").slice(0, FORM_ITEM_DESCRIPTION_MAX),
    unit: asUnit(choice.unit),
    quantityMode: "optional",
    minQtyMilli: null,
    maxQtyMilli: null,
  };
}

export function freeItem(id: string): EditorItem {
  return {
    id,
    kind: "free",
    catalogItemId: null,
    publicName: "",
    publicDescription: "",
    unit: "service",
    quantityMode: "optional",
    minQtyMilli: null,
    maxQtyMilli: null,
  };
}

/** Cambia de lugar un servicio (sube con -1, baja con 1). Fuera de rango no hace nada. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) {
    return [...list];
  }
  const copy = [...list];
  [copy[index], copy[target]] = [copy[target], copy[index]];
  return copy;
}

/** Lo que se manda a `save_intake_form`: sin claves de precio ni sitios para incrustar ni tope diario. */
export function toSavePayload(form: EditorForm): {
  form: Record<string, unknown>;
  items: Record<string, unknown>[];
} {
  return {
    form: {
      name: form.name.trim(),
      title: form.title.trim(),
      intro: form.intro.trim(),
      success_message: form.successMessage.trim(),
      fields: { ...form.fields },
      privacy_policy_url: form.privacyPolicyUrl.trim() === "" ? null : form.privacyPolicyUrl.trim(),
    },
    items: form.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      catalog_item_id: item.kind === "catalog" ? item.catalogItemId : null,
      public_name: item.publicName.trim(),
      public_description:
        item.publicDescription.trim() === "" ? null : item.publicDescription.trim(),
      unit: item.unit,
      quantity_mode: item.quantityMode,
      min_qty_milli: item.minQtyMilli,
      max_qty_milli: item.maxQtyMilli,
      is_active: true,
    })),
  };
}

/** Texto del enlace público de un formulario (solo para quien lo muestra con `getAppOrigin()`). */
export function publicFormUrl(origin: string, publicId: string): string {
  return `${origin.replace(/\/+$/, "")}/f/${publicId}`;
}
