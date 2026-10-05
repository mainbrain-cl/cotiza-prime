import "server-only";
import { cookies } from "next/headers";
import { tenantPath } from "@/lib/tenant/constants";
import { CUSTOMER_SEARCH_MAX_LENGTH, detectCustomerSearch } from "./search";

/**
 * Lo que se busca (RUT, correo, nombre) son datos personales: no puede viajar en la dirección, que
 * queda en el historial, el autocompletado y los registros del servidor. Se guarda unos minutos
 * en una cookie solo del servidor (`HttpOnly`, `SameSite=Strict`) acotada a la lista de clientes
 * de esa organización, y la dirección lleva solo `?buscar=1`.
 */
const SEARCH_COOKIE = "cp_customer_search";
const SEARCH_COOKIE_MAX_AGE_SECONDS = 10 * 60;

/** Parámetro de la dirección que dice "aplica la búsqueda guardada". */
export const SEARCH_ACTIVE_PARAM = "buscar";

function cookiePath(tenantId: string): string {
  return tenantPath(tenantId, "clientes");
}

/**
 * Guarda el término. De un RUT o un correo se guarda solo la forma normalizada que hace falta para
 * buscar su huella; del nombre, el texto limpio. Un término vacío borra la búsqueda.
 */
export async function saveCustomerSearch(tenantId: string, raw: string): Promise<void> {
  const search = detectCustomerSearch(raw.slice(0, CUSTOMER_SEARCH_MAX_LENGTH));
  if (search.kind === "none") return clearCustomerSearch(tenantId);
  const value =
    search.kind === "rut" ? search.rut : search.kind === "email" ? search.email : search.text;
  const store = await cookies();
  // Se codifica: un `%` suelto o una tilde en la cookie la dejarían ilegible.
  store.set(SEARCH_COOKIE, encodeURIComponent(value), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: cookiePath(tenantId),
    maxAge: SEARCH_COOKIE_MAX_AGE_SECONDS,
  });
}

export async function clearCustomerSearch(tenantId: string): Promise<void> {
  const store = await cookies();
  store.set(SEARCH_COOKIE, "", { path: cookiePath(tenantId), maxAge: 0 });
}

/** La búsqueda guardada, o `""` si no hay. */
export async function readCustomerSearch(): Promise<string> {
  const store = await cookies();
  // Next ya decodifica el valor al leerlo.
  return (store.get(SEARCH_COOKIE)?.value ?? "").slice(0, CUSTOMER_SEARCH_MAX_LENGTH);
}
