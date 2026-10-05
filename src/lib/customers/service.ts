import "server-only";
import { randomUUID } from "node:crypto";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { findDuplicates, type DuplicateMatch } from "./queries";
import { buildCustomerInsertRow } from "./record";
import type { CustomerInput } from "./schemas";

const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";

export const CUSTOMER_WRITER_ROLES: readonly string[] = ["owner", "admin", "sales"];
export const CUSTOMER_NO_PERMISSION = "Tu rol no permite registrar clientes.";
export const CUSTOMER_SAVE_FAILED =
  "No pudimos guardar el cliente. Intenta de nuevo en unos minutos.";

export type CreateCustomerResult =
  | { ok: true; id: string }
  | { ok: false; reason: "duplicates"; duplicates: DuplicateMatch[] }
  | { ok: false; reason: "forbidden" | "failed"; message: string };

/**
 * Núcleo para registrar un cliente (H-022), compartido por la pantalla de clientes y por el diálogo
 * "crear cliente" de la cotización (H-025). Revisa el rol, avisa de duplicados por huella (solo avisa:
 * con `confirmDuplicate` guarda igual) y cifra antes de guardar. No redirige: devuelve el resultado.
 */
export async function createCustomer(
  active: ActiveTenant,
  input: CustomerInput,
  confirmDuplicate: boolean,
): Promise<CreateCustomerResult> {
  if (!CUSTOMER_WRITER_ROLES.includes(active.role)) {
    return { ok: false, reason: "forbidden", message: CUSTOMER_NO_PERMISSION };
  }
  if (!confirmDuplicate) {
    const duplicates = await findDuplicates(active, input);
    if (duplicates.length > 0) return { ok: false, reason: "duplicates", duplicates };
  }
  const customerId = randomUUID();
  const row = buildCustomerInsertRow(input, active.tenantId, customerId);
  const { error } = await active.supabase.from("customers").insert(row);
  if (error) {
    await serverLog("error", "customer_insert_failed", { code: error.code });
    return {
      ok: false,
      reason: error.code === SQLSTATE_INSUFFICIENT_PRIVILEGE ? "forbidden" : "failed",
      message:
        error.code === SQLSTATE_INSUFFICIENT_PRIVILEGE
          ? CUSTOMER_NO_PERMISSION
          : CUSTOMER_SAVE_FAILED,
    };
  }
  return { ok: true, id: customerId };
}
