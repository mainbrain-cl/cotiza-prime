import "server-only";
import { PiiCryptoError } from "@/lib/crypto/pii";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid } from "@/lib/tenant/constants";
import {
  customerHashes,
  decodeCustomer,
  decodeCustomerSummary,
  type CustomerStoredRow,
  type CustomerSummary,
  type CustomerSummaryRow,
  type CustomerView,
} from "./record";
import type { CustomerInput } from "./schemas";
import { detectCustomerSearch, escapeLikePattern } from "./search";

/** La lista descifra solo lo que muestra; la dirección se lee únicamente en el detalle. */
const LIST_COLUMNS = "id, kind, display_name, email_enc, phone_enc, rut_enc, created_at";
const DETAIL_COLUMNS =
  "id, kind, display_name, email_enc, phone_enc, rut_enc, address_enc, created_at, updated_at";
/** Clientes por página de la lista. */
export const CUSTOMERS_PAGE_SIZE = 25;
const DUPLICATES_SHOWN = 5;
const PGRST_RANGE_NOT_SATISFIABLE = "PGRST103";

export type CustomerListItem =
  { ok: true; customer: CustomerSummary } | { ok: false; id: string; displayName: string };

export type DuplicateMatch = {
  id: string;
  displayName: string;
  matchedOn: ("rut" | "email")[];
};

async function logFailure(message: string, code?: string) {
  // Nunca datos personales: solo qué falló.
  await serverLog("error", message, { code });
}

export type CustomerPage = {
  items: CustomerListItem[];
  page: number;
  pageCount: number;
  total: number;
  /** Cómo se interpretó lo buscado, para decírselo a la persona. */
  searchKind: "none" | "rut" | "email" | "text";
};

/**
 * Clientes de la organización activa, por nombre y de a páginas. Lo buscado se interpreta en el
 * servidor: un correo o un RUT completos se buscan por huella (sin descifrar nada); lo demás es parte
 * del nombre. Un dato que no se puede descifrar no tumba la lista.
 */
export async function listCustomers(
  active: ActiveTenant,
  options: { search?: string; page?: number } = {},
): Promise<CustomerPage | null> {
  const search = detectCustomerSearch(options.search);
  const page = Number.isInteger(options.page) && (options.page ?? 0) >= 1 ? options.page! : 1;
  const from = (page - 1) * CUSTOMERS_PAGE_SIZE;

  let query = active.supabase
    .from("customers")
    .select(LIST_COLUMNS, { count: "exact" })
    .eq("tenant_id", active.tenantId);
  if (search.kind === "rut" || search.kind === "email") {
    const hashes = customerHashes(active.tenantId, {
      rut: search.kind === "rut" ? search.rut : null,
      email: search.kind === "email" ? search.email : null,
    });
    query =
      search.kind === "rut"
        ? query.eq("rut_hash", hashes.rutHash ?? "")
        : query.eq("email_hash", hashes.emailHash ?? "");
  } else if (search.kind === "text") {
    query = query.ilike("display_name", `%${escapeLikePattern(search.text)}%`);
  }
  const { data, error, count } = await query
    .order("display_name", { ascending: true })
    .order("id", { ascending: true })
    .range(from, from + CUSTOMERS_PAGE_SIZE - 1);
  // Una página que ya no existe (p. ej. un enlace viejo): se muestra la primera.
  if (error?.code === PGRST_RANGE_NOT_SATISFIABLE && page > 1) {
    return listCustomers(active, { ...options, page: 1 });
  }
  if (error || !data) {
    await logFailure("customers_list_failed", error?.code);
    return null;
  }
  const items: CustomerListItem[] = [];
  for (const row of data as CustomerSummaryRow[]) {
    try {
      items.push({ ok: true, customer: decodeCustomerSummary(row, active.tenantId) });
    } catch (cause) {
      if (!(cause instanceof PiiCryptoError)) throw cause;
      await logFailure("customer_decrypt_failed");
      items.push({ ok: false, id: row.id, displayName: row.display_name });
    }
  }
  const total = count ?? items.length;
  return {
    items,
    page,
    pageCount: Math.max(1, Math.ceil(total / CUSTOMERS_PAGE_SIZE)),
    total,
    searchKind: search.kind,
  };
}

/** Un cliente de la organización activa, o `null` si no existe en ella. */
export async function getCustomer(
  active: ActiveTenant,
  customerId: string,
): Promise<CustomerView | null | "unreadable"> {
  if (!isUuid(customerId)) return null;
  const { data, error } = await active.supabase
    .from("customers")
    .select(DETAIL_COLUMNS)
    .eq("tenant_id", active.tenantId)
    .eq("id", customerId)
    .maybeSingle();
  if (error) {
    await logFailure("customer_get_failed", error.code);
    return null;
  }
  if (!data) return null;
  try {
    return decodeCustomer(data as CustomerStoredRow, active.tenantId);
  } catch (cause) {
    if (!(cause instanceof PiiCryptoError)) throw cause;
    await logFailure("customer_decrypt_failed");
    return "unreadable";
  }
}

/** Clientes de ESTA organización con el mismo RUT o el mismo correo. Se compara por huella, sin descifrar. */
export async function findDuplicates(
  active: ActiveTenant,
  input: Pick<CustomerInput, "rut" | "email">,
  excludeCustomerId?: string,
): Promise<DuplicateMatch[]> {
  const { rutHash, emailHash } = customerHashes(active.tenantId, input);
  const conditions = [
    rutHash ? `rut_hash.eq.${rutHash}` : null,
    emailHash ? `email_hash.eq.${emailHash}` : null,
  ].filter((condition): condition is string => condition !== null);
  if (conditions.length === 0) return [];

  let query = active.supabase
    .from("customers")
    .select("id, display_name, rut_hash, email_hash")
    .eq("tenant_id", active.tenantId);
  // Al editar, el propio cliente no cuenta como duplicado de sí mismo.
  if (excludeCustomerId) query = query.neq("id", excludeCustomerId);
  const { data, error } = await query
    .or(conditions.join(","))
    .order("display_name", { ascending: true })
    .limit(DUPLICATES_SHOWN);
  if (error || !data) {
    await logFailure("customer_duplicates_failed", error?.code);
    return [];
  }
  return data.map((row) => {
    const matchedOn: DuplicateMatch["matchedOn"] = [];
    if (rutHash && row.rut_hash === rutHash) matchedOn.push("rut");
    if (emailHash && row.email_hash === emailHash) matchedOn.push("email");
    return { id: row.id as string, displayName: row.display_name as string, matchedOn };
  });
}
