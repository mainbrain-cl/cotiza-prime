/**
 * Constantes de la organización activa (docs/arquitectura/modelo-datos.md §2.2 y §2.3).
 *
 * Este es el ÚNICO archivo donde puede escribirse el nombre de la cabecera: una regla del linter
 * prohíbe el texto en cualquier otro lugar.
 */

/** Cabecera con la que el servidor le dice a la base de datos cuál es la organización activa. */
export const TENANT_HEADER = "x-cp-tenant-id";

/** Cabeceras orientativas para la auditoría (origen y correlación). */
export const REQUEST_ID_HEADER = "x-cp-request-id";
export const CLIENT_IP_HEADER = "x-cp-client-ip";

/** Prefijo de las pantallas de una organización: `/o/{tenantId}/...`. */
export const TENANT_ROUTE_PREFIX = "/o";

/** La "organización" que es dueña de los datos globales (cuentas, términos y eventos sin organización). */
export const PLATFORM_TENANT_ID = "00000000-0000-4000-8000-000000000001";

export function tenantPath(tenantId: string, subPath = ""): string {
  const suffix = subPath === "" ? "" : `/${subPath.replace(/^\/+/, "")}`;
  return `${TENANT_ROUTE_PREFIX}/${tenantId}${suffix}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** UUID escrito en la forma canónica: 36 caracteres, en minúsculas. Es lo único que acepta la dirección. */
export function isCanonicalUuid(value: string): boolean {
  return value === value.toLowerCase() && UUID_PATTERN.test(value);
}
