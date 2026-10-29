/**
 * Solicitudes que llegan por el formulario público (H-089): lo que es puro (filtros, textos, permisos
 * por rol, «hace cuánto llegó»). Sin acceso a la base ni a dinero: una solicitud nunca lleva precios.
 */
import { can } from "@/lib/permissions/matrix";
import type { MemberRole } from "@/lib/tenant/active-tenant";
import { itemUnitShort } from "./builder-model";

export const REQUEST_STATUSES = ["new", "assigned", "converted", "discarded"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  new: "Sin asignar",
  assigned: "Asignada",
  converted: "Convertida",
  discarded: "Descartada",
};

export const REQUEST_FILTERS = [
  { value: "todas", label: "Todas" },
  { value: "sin-asignar", label: "Sin asignar" },
  { value: "mias", label: "Asignadas a mí" },
  { value: "convertidas", label: "Convertidas" },
  { value: "descartadas", label: "Descartadas" },
] as const;
export type RequestFilter = (typeof REQUEST_FILTERS)[number]["value"];
export const DEFAULT_REQUEST_FILTER: RequestFilter = "todas";

/** Lo que llega en la dirección (`?estado=`): lo que no se reconoce vuelve al valor por defecto. */
export function parseRequestFilter(value: unknown): RequestFilter {
  const found = REQUEST_FILTERS.find((filter) => filter.value === value);
  return found ? found.value : DEFAULT_REQUEST_FILTER;
}

/** Cuántas solicitudes se leen como máximo en la lista. */
export const REQUEST_LIST_LIMIT = 100;

export const DISCARD_REASONS = [
  { value: "spam", label: "Spam o mensaje basura" },
  { value: "duplicate", label: "Solicitud duplicada" },
  { value: "out_of_scope", label: "Fuera de lo que ofrecemos" },
  { value: "other", label: "Otro motivo" },
] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number]["value"];
export const DISCARD_NOTE_MAX = 200;

export function discardReasonLabel(reason: string | null): string {
  return DISCARD_REASONS.find((r) => r.value === reason)?.label ?? "Sin motivo";
}

export const ANONYMIZE_REASONS = [
  { value: "data_subject_request", label: "La persona pidió que borremos sus datos" },
  { value: "wrong_data", label: "Los datos son incorrectos o no debían guardarse" },
  { value: "other", label: "Otro motivo" },
] as const;
export type AnonymizeReason = (typeof ANONYMIZE_REASONS)[number]["value"];

export function isDiscardReason(value: unknown): value is DiscardReason {
  return DISCARD_REASONS.some((r) => r.value === value);
}
export function isAnonymizeReason(value: unknown): value is AnonymizeReason {
  return ANONYMIZE_REASONS.some((r) => r.value === value);
}

export type RequestPermissions = {
  canAssign: boolean;
  canDiscard: boolean;
  canRestore: boolean;
  canAnonymize: boolean;
  /** Quien puede convertirla en cotización (H-090): Dueño, Administrador, o el Comercial dueño de la solicitud. */
  canConvert: boolean;
};

/**
 * Permisos de la matriz del plan (`src/lib/permissions/matrix.ts`). Es solo para decidir qué botones
 * se muestran: la base de datos vuelve a verificar cada acción. El Comercial descarta y restaura solo
 * las solicitudes asignadas a él, y convierte las asignadas a él o las que nadie tiene.
 */
export function requestPermissions(
  role: MemberRole,
  userId: string,
  request: { status: RequestStatus; assignedTo: string | null; anonymized: boolean },
): RequestPermissions {
  const mine = request.assignedTo === userId;
  const open = request.status === "new" || request.status === "assigned";
  const live = !request.anonymized;
  return {
    canAssign: can(role, "intake.requests.assign") && open && live,
    canDiscard: can(role, "intake.requests.discard", { isOwn: mine }) && open,
    canRestore:
      can(role, "intake.requests.restore", { isOwn: mine }) && request.status === "discarded",
    canAnonymize: can(role, "intake.requests.anonymize") && live,
    canConvert:
      live &&
      open &&
      can(role, "intake.requests.convert", { isOwn: request.assignedTo === null || mine }),
  };
}

export type RequestItemCopy = {
  name: string;
  unit: string;
  quantityMilli: number | null;
};

/** La copia congelada de los servicios pedidos (`items` de la base). Lo que no calza se ignora. */
export function parseRequestItems(raw: unknown): RequestItemCopy[] {
  if (!Array.isArray(raw)) return [];
  const items: RequestItemCopy[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== "string" || row.name === "") continue;
    const milli = typeof row.quantity_milli === "number" ? row.quantity_milli : null;
    items.push({
      name: row.name,
      unit: typeof row.unit === "string" ? row.unit : "",
      quantityMilli: milli,
    });
  }
  return items;
}

const quantityFormat = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 3 });

/** «12,5 km», «3 unidades» o vacío si no se pidió cantidad. */
export function formatRequestQuantity(item: RequestItemCopy): string {
  if (item.quantityMilli === null) return "";
  const amount = quantityFormat.format(item.quantityMilli / 1000);
  const unit = itemUnitShort(item.unit);
  return unit ? `${amount} ${unit}` : amount;
}

const SUMMARY_ITEMS_SHOWN = 3;

/** Los servicios en una línea para la lista: «Flete urbano · Traslado por kilómetro (12,5 km)». */
export function summarizeRequestItems(
  items: readonly RequestItemCopy[],
  max = SUMMARY_ITEMS_SHOWN,
): string {
  if (items.length === 0) return "Sin servicios";
  const parts = items.slice(0, max).map((item) => {
    const quantity = formatRequestQuantity(item);
    return quantity ? `${item.name} (${quantity})` : item.name;
  });
  const rest = items.length - parts.length;
  return rest > 0 ? `${parts.join(" · ")} · y ${rest} más` : parts.join(" · ");
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** «Hace 5 minutos», «hace 3 días»… Para fechas futuras o mal escritas, «Hace un momento». */
export function timeSince(from: string | Date, now: Date = new Date()): string {
  const elapsed = now.getTime() - new Date(from).getTime();
  if (!Number.isFinite(elapsed) || elapsed < MINUTE_MS) return "Hace un momento";
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return minutes === 1 ? "Hace 1 minuto" : `Hace ${minutes} minutos`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return hours === 1 ? "Hace 1 hora" : `Hace ${hours} horas`;
  }
  const days = Math.floor(elapsed / DAY_MS);
  return days === 1 ? "Hace 1 día" : `Hace ${days} días`;
}

/** Una solicitud abierta lleva «mucho» sin atender a partir de este tiempo (se resalta en la lista). */
export const STALE_REQUEST_HOURS = 24;

export function isStale(
  status: RequestStatus,
  createdAt: string | Date,
  now: Date = new Date(),
): boolean {
  if (status !== "new" && status !== "assigned") return false;
  return now.getTime() - new Date(createdAt).getTime() >= STALE_REQUEST_HOURS * HOUR_MS;
}

export const DATA_DELETED_LABEL = "Datos eliminados";
