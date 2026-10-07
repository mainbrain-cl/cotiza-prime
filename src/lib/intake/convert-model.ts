/**
 * Convertir una solicitud en cotización (H-090): lo que es puro, sin base de datos ni sesión.
 * Cómo se leen los servicios de la copia congelada de la solicitud, qué líneas se pueden cargar y cómo
 * se traducen los errores de la base a mensajes claros (sin detalle técnico).
 */
import { z } from "zod";
import { customerSchema } from "@/lib/customers/schemas";
import { QUANTITY_MAX_MILLI, QUANTITY_MIN_MILLI } from "@/lib/quotes/calc";

/** Cantidad que lleva una línea cuando la solicitud no pidió cantidad (1). */
export const DEFAULT_QUANTITY_MILLI = 1000;

/** Un servicio pedido en la solicitud, con el servicio del catálogo al que apunta (si apunta a uno). */
export type RequestedService = {
  name: string;
  unit: string;
  catalogItemId: string | null;
  quantityMilli: number | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lee los servicios de la copia congelada (`items` de la base). Lo que no calza se ignora. */
export function parseRequestedServices(raw: unknown): RequestedService[] {
  if (!Array.isArray(raw)) return [];
  const services: RequestedService[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== "string" || row.name === "") continue;
    const catalogItemId =
      typeof row.catalog_item_id === "string" && UUID.test(row.catalog_item_id)
        ? row.catalog_item_id
        : null;
    services.push({
      name: row.name,
      unit: typeof row.unit === "string" ? row.unit : "",
      catalogItemId,
      quantityMilli: typeof row.quantity_milli === "number" ? row.quantity_milli : null,
    });
  }
  return services;
}

/** Cantidad de la línea: la de la solicitud, o 1 si no pidió cantidad. `null` si no es utilizable. */
export function lineQuantityMilli(service: RequestedService): number | null {
  const milli = service.quantityMilli ?? DEFAULT_QUANTITY_MILLI;
  if (!Number.isInteger(milli) || milli < QUANTITY_MIN_MILLI || milli > QUANTITY_MAX_MILLI) {
    return null;
  }
  return milli;
}

/** Servicio del catálogo tal como está hoy (solo los activos llegan hasta aquí). */
export type CatalogSnapshot = {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  unitPriceClp: number;
  taxTreatment: "taxable" | "exempt";
};

export type LinePlan = {
  /** Los servicios que se cargan como línea, en el orden en que se pidieron. */
  lines: { service: RequestedService; catalog: CatalogSnapshot; quantityMilli: number }[];
  /** Los del catálogo que ya no están activos (o no se pueden cargar): no son línea, se avisan. */
  skipped: RequestedService[];
};

/**
 * Qué servicios de la solicitud pasan a ser línea: los del catálogo que siguen activos. Los libres
 * (sin servicio del catálogo) no son línea: no tienen precio y el equipo los cotiza a mano.
 */
export function planLines(
  services: readonly RequestedService[],
  activeCatalog: ReadonlyMap<string, CatalogSnapshot>,
): LinePlan {
  const plan: LinePlan = { lines: [], skipped: [] };
  for (const service of services) {
    if (service.catalogItemId === null) continue;
    const catalog = activeCatalog.get(service.catalogItemId);
    const quantityMilli = lineQuantityMilli(service);
    if (!catalog || quantityMilli === null) {
      plan.skipped.push(service);
      continue;
    }
    plan.lines.push({ service, catalog, quantityMilli });
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Lo que manda la pantalla
// ---------------------------------------------------------------------------------------------

const idSchema = z.uuid();

const newCustomerInput = z.object({
  mode: z.literal("new"),
  // El identificador del cliente nuevo NO viaja: el servidor lo deriva de la organización y la
  // solicitud (`deriveConvertCustomerId`), así dos clics o dos pestañas llegan al mismo cliente.
  creationKey: idSchema,
  confirmDuplicate: z.boolean(),
  customer: z.object({
    kind: z.string(),
    displayName: z.string(),
    rut: z.string(),
    email: z.string(),
    phone: z.string(),
    address: z.string(),
  }),
});

const existingCustomerInput = z.object({
  mode: z.literal("existing"),
  customerId: idSchema,
  creationKey: idSchema,
});

export const convertInputSchema = z.discriminatedUnion("mode", [
  newCustomerInput,
  existingCustomerInput,
]);
export type ConvertInput = z.infer<typeof convertInputSchema>;

export { customerSchema };

// ---------------------------------------------------------------------------------------------
// Errores de la base
// ---------------------------------------------------------------------------------------------

export type ConvertErrorKind =
  "forbidden" | "not_found" | "discarded" | "key_reused" | "customer" | "other";

export const CONVERT_GENERIC_FAILURE =
  "No pudimos crear la cotización. Intenta de nuevo en unos minutos; si sigue igual, avísanos.";
export const CONVERT_NOT_FOUND = "No encontramos esta solicitud. Puede que ya no exista.";
export const CONVERT_FORBIDDEN =
  "No puedes convertir esta solicitud: está a cargo de otra persona. Pídele a un Administrador que te la asigne.";
export const CONVERT_DISCARDED =
  "Esta solicitud está descartada. Restáurala si quieres convertirla en cotización.";
export const CONVERT_ANONYMIZED =
  "Los datos de esta solicitud fueron eliminados: ya no se puede convertir en cotización.";
export const CONVERT_KEY_REUSED = "Esa clave ya se usó; recarga e inténtalo de nuevo.";
export const CONVERT_CUSTOMER_GONE = "Ese cliente ya no está disponible. Elige otro.";

export function mapConvertError(error: { code?: string | null; message?: string | null }): {
  kind: ConvertErrorKind;
  message: string;
} {
  const code = error.code ?? "";
  if (code === "42501") return { kind: "forbidden", message: CONVERT_FORBIDDEN };
  if (code === "CP423") return { kind: "discarded", message: CONVERT_DISCARDED };
  if (code === "CP404") {
    // La base distingue la solicitud del cliente por el texto del error.
    if ((error.message ?? "").startsWith("request_not_found")) {
      return { kind: "not_found", message: CONVERT_NOT_FOUND };
    }
    return { kind: "customer", message: CONVERT_CUSTOMER_GONE };
  }
  if (code === "CP422" && (error.message ?? "").startsWith("creation_key_reused")) {
    return { kind: "key_reused", message: CONVERT_KEY_REUSED };
  }
  return { kind: "other", message: CONVERT_GENERIC_FAILURE };
}
