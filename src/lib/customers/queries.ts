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

/** La lista descifra solo lo que muestra; la dirección se lee únicamente en el detalle. */
const LIST_COLUMNS = "id, kind, display_name, email_enc, phone_enc, rut_enc, created_at";
const DETAIL_COLUMNS =
  "id, kind, display_name, email_enc, phone_enc, rut_enc, address_enc, created_at";
/** Tope de la lista simple de H-022; la búsqueda y la paginación llegan con H-023. */
export const CUSTOMER_LIST_LIMIT = 200;
const DUPLICATES_SHOWN = 5;

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

/** Clientes de la organización activa, por nombre. Un dato que no se puede descifrar no tumba la lista. */
export async function listCustomers(active: ActiveTenant): Promise<CustomerListItem[] | null> {
  const { data, error } = await active.supabase
    .from("customers")
    .select(LIST_COLUMNS)
    .eq("tenant_id", active.tenantId)
    .order("display_name", { ascending: true })
    .limit(CUSTOMER_LIST_LIMIT);
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
  return items;
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
): Promise<DuplicateMatch[]> {
  const { rutHash, emailHash } = customerHashes(active.tenantId, input);
  const conditions = [
    rutHash ? `rut_hash.eq.${rutHash}` : null,
    emailHash ? `email_hash.eq.${emailHash}` : null,
  ].filter((condition): condition is string => condition !== null);
  if (conditions.length === 0) return [];

  const { data, error } = await active.supabase
    .from("customers")
    .select("id, display_name, rut_hash, email_hash")
    .eq("tenant_id", active.tenantId)
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
