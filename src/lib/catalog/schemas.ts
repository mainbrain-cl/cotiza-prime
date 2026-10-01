import { z } from "zod";
import { parseClp } from "@/lib/money/clp";

/** Unidades permitidas: coinciden con el `check` de `catalog_items.unit` en la base. */
export const CATALOG_UNITS = [
  { value: "service", label: "Servicio" },
  { value: "hour", label: "Hora" },
  { value: "km", label: "Kilómetro" },
  { value: "m2", label: "Metro cuadrado (m²)" },
  { value: "day", label: "Día" },
  { value: "unit", label: "Unidad" },
] as const;

export const TAX_TREATMENTS = [
  { value: "taxable", label: "Afecto a IVA" },
  { value: "exempt", label: "Exento de IVA" },
] as const;

/** Filtro de la lista del catálogo: por defecto solo los servicios que se ofrecen al cotizar. */
export const CATALOG_STATUS_FILTERS = [
  { value: "activos", label: "Activos" },
  { value: "inactivos", label: "Inactivos" },
  { value: "todos", label: "Todos" },
] as const;

export type CatalogStatusFilter = (typeof CATALOG_STATUS_FILTERS)[number]["value"];

export function parseCatalogStatusFilter(value: unknown): CatalogStatusFilter {
  const found = CATALOG_STATUS_FILTERS.find((filter) => filter.value === value);
  return found ? found.value : "activos";
}

export const CATALOG_NAME_MAX_LENGTH = 150;
export const CATALOG_DESCRIPTION_MAX_LENGTH = 2000;
export const CATALOG_SEARCH_MAX_LENGTH = 100;

const unitValues = CATALOG_UNITS.map((unit) => unit.value) as [string, ...string[]];
const taxValues = TAX_TREATMENTS.map((tax) => tax.value) as [string, ...string[]];

const PRICE_MESSAGES = {
  empty: "Ingresa el precio neto.",
  negative: "El precio no puede ser negativo.",
  decimal: "Usa pesos enteros, sin decimales. Por ejemplo, 15000.",
  invalid: "Escribe solo números. Por ejemplo, 15000 o 15.000.",
  too_large: "El precio es demasiado alto. Revisa los ceros.",
} as const;

export const createCatalogItemSchema = z.object({
  name: z
    .string({ error: "Ingresa el nombre del servicio." })
    .trim()
    .min(1, "Ingresa el nombre del servicio.")
    .max(CATALOG_NAME_MAX_LENGTH, "El nombre es demasiado largo."),
  description: z
    .string()
    .trim()
    .max(CATALOG_DESCRIPTION_MAX_LENGTH, "La descripción es demasiado larga.")
    .transform((value) => (value === "" ? null : value)),
  unit: z.enum(unitValues, { error: "Elige una unidad." }),
  unitPriceClp: z.string({ error: PRICE_MESSAGES.empty }).transform((text, context) => {
    const result = parseClp(text);
    if (!result.ok) {
      context.addIssue({ code: "custom", message: PRICE_MESSAGES[result.reason] });
      return z.NEVER;
    }
    return result.value;
  }),
  taxTreatment: z.enum(taxValues, { error: "Indica si lleva IVA o es exento." }),
});

export type CreateCatalogItemInput = z.infer<typeof createCatalogItemSchema>;

export function unitLabel(unit: string): string {
  return CATALOG_UNITS.find((u) => u.value === unit)?.label ?? unit;
}
