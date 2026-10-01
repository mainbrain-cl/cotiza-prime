"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import type { FormState } from "@/lib/auth/form-state";
import { fieldErrorsOf } from "@/lib/auth/schemas";
import { serverLog } from "@/lib/log/server-log";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { findDuplicates, type DuplicateMatch } from "./queries";
import { buildCustomerInsertRow } from "./record";
import { customerSchema } from "./schemas";

export type CustomerFormState = FormState & { duplicates?: DuplicateMatch[] };

const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";
const ROLES_THAT_CAN_WRITE: readonly string[] = ["owner", "admin", "sales"];
const FIELDS = ["kind", "displayName", "rut", "email", "phone", "address"] as const;
const NO_PERMISSION = "Tu rol no permite registrar clientes.";

function readText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * H-022: registra un cliente. Valida en el servidor, avisa si ya existe uno con el mismo RUT o correo
 * en la organización (solo avisa: con `confirmDuplicate` guarda igual) y cifra antes de guardar.
 */
export async function createCustomerAction(
  tenantId: string,
  _previous: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  const active = await requireActiveTenant(tenantId);

  const raw = Object.fromEntries(FIELDS.map((name) => [name, readText(formData, name)]));
  if (!ROLES_THAT_CAN_WRITE.includes(active.role)) {
    return { status: "error", message: NO_PERMISSION, values: raw };
  }

  const parsed = customerSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  }

  if (readText(formData, "confirmDuplicate") !== "1") {
    const duplicates = await findDuplicates(active, parsed.data);
    if (duplicates.length > 0) return { status: "error", duplicates, values: raw };
  }

  const customerId = randomUUID();
  const row = buildCustomerInsertRow(parsed.data, active.tenantId, customerId);
  const { error } = await active.supabase.from("customers").insert(row);
  if (error) {
    await serverLog("error", "customer_insert_failed", { code: error.code });
    return {
      status: "error",
      message:
        error.code === SQLSTATE_INSUFFICIENT_PRIVILEGE
          ? NO_PERMISSION
          : "No pudimos guardar el cliente. Intenta de nuevo en unos minutos.",
      values: raw,
    };
  }

  redirect(`${tenantPath(active.tenantId, `clientes/${customerId}`)}?creado=1`);
}
