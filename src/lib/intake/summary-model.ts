import type { FieldModes, QuantityMode } from "./field-modes";

/**
 * Resumen en vivo de lo que la persona está pidiendo, para el formulario público y para la pantalla
 * de la solicitud. Es una función pura y NO importa nada de dinero (`@/lib/money`, `quotes/calc`,
 * catálogo): el resumen no tiene dónde mostrar un monto. Solo trabaja con textos.
 */

export type SummaryItemConfig = {
  id: string;
  /** Nombre público del servicio, el mismo que ve la persona. */
  publicName: string;
  /** Unidad escrita (`km`, `hora`…), si la hay. */
  unit?: string | null;
  quantityMode: QuantityMode;
};

export type SummaryConfig = {
  fields: FieldModes;
  items: readonly SummaryItemConfig[];
};

export type SummaryDraft = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  comuna?: string | null;
  serviceAddress?: string | null;
  /** `YYYY-MM-DD`. */
  desiredDate?: string | null;
  message?: string | null;
  items?: readonly { formItemId: string; quantity?: string | null }[];
};

export type SummarySection = "services" | "contact" | "details";

export type SummaryLine = {
  /** Estable para usar como `key` en la pantalla. */
  key: string;
  section: SummarySection;
  label: string;
  /** Para servicios, la cantidad con su unidad (puede ir vacía). */
  value: string;
  /** El mensaje conserva sus saltos de línea. */
  multiline?: boolean;
};

export type RequestSummary = {
  services: SummaryLine[];
  contact: SummaryLine[];
  details: SummaryLine[];
  itemCount: number;
  /** Aún no hay nada que mostrar. */
  isEmpty: boolean;
};

const LABELS = {
  name: "Nombre",
  email: "Correo",
  phone: "Teléfono",
  company: "Empresa",
  comuna: "Comuna",
  serviceAddress: "Dirección del servicio",
  desiredDate: "Fecha deseada",
  message: "Mensaje",
} as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function clean(value: string | null | undefined): string {
  return (value ?? "").normalize("NFC").trim();
}

/** `2026-10-07` -> `07-10-2026`. Si no tiene esa forma devuelve el texto tal cual. */
export function formatSummaryDate(value: string): string {
  const match = DATE_PATTERN.exec(value);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : value;
}

function contactLine(key: keyof typeof LABELS, value: string): SummaryLine | null {
  if (value === "") return null;
  return { key, section: "contact", label: LABELS[key], value };
}

export function buildRequestSummary(config: SummaryConfig, draft: SummaryDraft): RequestSummary {
  const itemRules = new Map(config.items.map((item) => [item.id, item]));
  const seen = new Set<string>();

  const services: SummaryLine[] = [];
  for (const picked of draft.items ?? []) {
    const rule = itemRules.get(picked.formItemId);
    if (!rule || seen.has(picked.formItemId)) continue;
    seen.add(picked.formItemId);
    const quantity = rule.quantityMode === "none" ? "" : clean(picked.quantity);
    const unit = clean(rule.unit);
    services.push({
      key: `item:${rule.id}`,
      section: "services",
      label: rule.publicName,
      value: quantity === "" ? "" : unit === "" ? quantity : `${quantity} ${unit}`,
    });
  }

  const contact: SummaryLine[] = [];
  const push = (line: SummaryLine | null) => {
    if (line) contact.push(line);
  };
  push(contactLine("name", clean(draft.name)));
  push(contactLine("email", clean(draft.email)));
  if (config.fields.phone !== "off") push(contactLine("phone", clean(draft.phone)));
  if (config.fields.company !== "off") push(contactLine("company", clean(draft.company)));
  if (config.fields.comuna !== "off") push(contactLine("comuna", clean(draft.comuna)));
  if (config.fields.serviceAddress !== "off") {
    push(contactLine("serviceAddress", clean(draft.serviceAddress)));
  }

  const details: SummaryLine[] = [];
  if (config.fields.desiredDate !== "off") {
    const date = clean(draft.desiredDate);
    if (date !== "") {
      details.push({
        key: "desiredDate",
        section: "details",
        label: LABELS.desiredDate,
        value: formatSummaryDate(date),
      });
    }
  }
  if (config.fields.message !== "off") {
    const message = clean(draft.message);
    if (message !== "") {
      details.push({
        key: "message",
        section: "details",
        label: LABELS.message,
        value: message,
        multiline: true,
      });
    }
  }

  return {
    services,
    contact,
    details,
    itemCount: services.length,
    isEmpty: services.length + contact.length + details.length === 0,
  };
}
