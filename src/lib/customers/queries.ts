import "server-only";
import { PiiCryptoError } from "@/lib/crypto/pii";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid } from "@/lib/tenant/constants";
import {
  customerHashes,
  decodeCustomer,
  type CustomerStoredRow,
  type CustomerView,
} from "./record";
import type { CustomerInput } from "./schemas";

const COLUMNS = "id, kind, display_name, email_enc, phone_enc, rut_enc, address_enc, created_at";
/** Tope de la lista simple de H-022; la búsqueda y la paginación llegan con H-023. */
export const CUSTOMER_LIST_LIMIT = 200;
const DUPLICATES_SHOWN = 5;

export type CustomerListItem =
  { ok: true; customer: CustomerView } | { ok: false; id: string; displayName: string };

export type DuplicateMatch = {
  id: string;
  displayName: string;
  matchedOn: ("rut" | "email")[];
};

function logFailure(message: string, code?: string) {
  // Nunca datos personales: solo qué falló.
  console.error(JSON.stringify({ level: "error", message, code }));
}

/** Clientes de la organización activa, por nombre. Un dato que no se puede descifrar no tumba la lista. */
export async function listCustomers(active: ActiveTenant): Promise<CustomerListItem[] | null> {
  const { data, error } = await active.supabase
    .from("customers")
    .select(COLUMNS)
    .eq("tenant_id", active.tenantId)
    .order("display_name", { ascending: true })
    .limit(CUSTOMER_LIST_LIMIT);
  if (error || !data) {
    logFailure("customers_list_failed", error?.code);
    return null;
  }
  return (data as CustomerStoredRow[]).map((row): CustomerListItem => {
    try {
      return { ok: true, customer: decodeCustomer(row, active.tenantId) };
    } catch (cause) {
      if (!(cause instanceof PiiCryptoError)) throw cause;
      logFailure("customer_decrypt_failed");
      return { ok: false, id: row.id, displayName: row.display_name };
    }
  });
}

/** Un cliente de la organización activa, o `null` si no existe en ella. */
export async function getCustomer(
  active: ActiveTenant,
  customerId: string,
): Promise<CustomerView | null | "unreadable"> {
  if (!isUuid(customerId)) return null;
  const { data, error } = await active.supabase
    .from("customers")
    .select(COLUMNS)
    .eq("tenant_id", active.tenantId)
    .eq("id", customerId)
    .maybeSingle();
  if (error) {
    logFailure("customer_get_failed", error.code);
    return null;
  }
  if (!data) return null;
  try {
    return decodeCustomer(data as CustomerStoredRow, active.tenantId);
  } catch (cause) {
    if (!(cause instanceof PiiCryptoError)) throw cause;
    logFailure("customer_decrypt_failed");
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
    logFailure("customer_duplicates_failed", error?.code);
    return [];
  }
  return data.map((row) => {
    const matchedOn: DuplicateMatch["matchedOn"] = [];
    if (rutHash && row.rut_hash === rutHash) matchedOn.push("rut");
    if (emailHash && row.email_hash === emailHash) matchedOn.push("email");
    return { id: row.id as string, displayName: row.display_name as string, matchedOn };
  });
}
