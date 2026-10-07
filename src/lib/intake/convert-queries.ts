import "server-only";
import { findDuplicates, type DuplicateMatch } from "@/lib/customers/queries";
import { normalizeEmail } from "@/lib/normalize/email";
import { newCatalogLine, type EditorLine } from "@/lib/quotes/editor-model";
import { formatQuantity } from "@/lib/quotes/format";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid } from "@/lib/tenant/constants";
import { planRequestLines } from "./convert-lines";
import { parseRequestedServices, type RequestedService } from "./convert-model";
import { loadRequest, type RequestDetail } from "./requests-queries";

/** Clientes de esta organización con el mismo correo que dejó quien pidió la cotización. */
export async function findRequestCustomerDuplicates(
  active: ActiveTenant,
  email: string | null,
): Promise<DuplicateMatch[]> {
  if (!email) return [];
  return findDuplicates(active, { rut: null, email: normalizeEmail(email) });
}

/** De qué solicitud nació esta cotización (`null` si se armó a mano). Se lee con la sesión. */
export async function loadQuoteSourceRequestId(
  active: ActiveTenant,
  quoteId: string,
): Promise<string | null> {
  const { data } = await active.supabase
    .from("quotes")
    .select("source_request_id")
    .eq("tenant_id", active.tenantId)
    .eq("id", quoteId)
    .maybeSingle();
  const id = (data as { source_request_id?: string | null } | null)?.source_request_id;
  return typeof id === "string" ? id : null;
}

export type SourceRequestPanel = {
  requestId: string;
  anonymized: boolean;
  createdAt: string;
  services: RequestedService[];
  message: string | null;
  serviceAddress: string | null;
  comuna: string | null;
  desiredDate: string | null;
  /** Servicios del catálogo pedidos que no son línea: ya no están activos o no se pudieron cargar. */
  notLoaded: RequestedService[];
  /** Líneas que el editor puede ofrecer cargar (solo si la cotización no tiene ninguna). */
  seedLines: EditorLine[];
  unreadable: boolean;
};

/**
 * Lo que el equipo ve en «Solicitud original» dentro de la cotización: los servicios pedidos y el
 * mensaje del visitante, descifrados aquí con la sesión de quien mira. Solo se muestra como texto plano.
 * `quoteCatalogIds` son los servicios del catálogo que la cotización ya tiene como línea.
 */
export async function loadSourceRequestPanel(
  active: ActiveTenant,
  sourceRequestId: string | null,
  quoteCatalogIds: readonly string[],
  offerSeedLines: boolean,
): Promise<SourceRequestPanel | null> {
  if (!sourceRequestId || !isUuid(sourceRequestId)) return null;
  const loaded = await loadRequest(active, sourceRequestId);
  if (!loaded.ok) return null;
  const detail: RequestDetail = loaded.detail;
  const { data } = await active.supabase
    .from("intake_requests")
    .select("items")
    .eq("id", sourceRequestId)
    .maybeSingle();
  const services = parseRequestedServices((data as { items?: unknown } | null)?.items);

  const plan = await planRequestLines(active, services);
  const inQuote = new Set(quoteCatalogIds);
  const notLoaded = (plan?.skipped ?? []).filter(
    (service) => service.catalogItemId === null || !inQuote.has(service.catalogItemId),
  );
  const seedLines: EditorLine[] = !offerSeedLines
    ? []
    : (plan?.lines ?? []).map(({ catalog, quantityMilli }) => ({
        ...newCatalogLine(crypto.randomUUID(), catalog),
        quantity: formatQuantity(quantityMilli),
      }));
  return {
    requestId: sourceRequestId,
    anonymized: detail.anonymized,
    createdAt: detail.createdAt,
    services,
    message: detail.contact.message,
    serviceAddress: detail.contact.serviceAddress,
    comuna: detail.contact.comuna,
    desiredDate: detail.desiredDate,
    notLoaded,
    seedLines,
    unreadable: detail.unreadable,
  };
}
