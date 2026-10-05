"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/lib/auth/form-state";
import { fieldErrorsOf } from "@/lib/auth/schemas";
import { serverLog } from "@/lib/log/server-log";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid, tenantPath } from "@/lib/tenant/constants";
import { findDuplicates, getCustomer, type DuplicateMatch } from "./queries";
import { buildCustomerChangeRow } from "./record";
import { customerSchema } from "./schemas";
import { createCustomer } from "./service";
import { SEARCH_ACTIVE_PARAM, clearCustomerSearch, saveCustomerSearch } from "./search-cookie";

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

  const created = await createCustomer(
    active,
    parsed.data,
    readText(formData, "confirmDuplicate") === "1",
  );
  if (!created.ok) {
    if (created.reason === "duplicates") {
      return { status: "error", duplicates: created.duplicates, values: raw };
    }
    return { status: "error", message: created.message, values: raw };
  }
  const customerId = created.id;

  redirect(`${tenantPath(active.tenantId, `clientes/${customerId}`)}?creado=1`);
}

const NO_PERMISSION_EDIT = "Tu rol no permite editar clientes.";

/**
 * H-023: guarda los cambios de un cliente. Vuelve a validar, a cifrar (con el mismo contexto) y a
 * calcular las huellas; si cambió el RUT o el correo, revisa de nuevo si ya existe otro cliente igual.
 * Quién lo cambió lo registran la base (`updated_by`) y la auditoría, solo con los nombres de los campos.
 */
export async function updateCustomerAction(
  tenantId: string,
  customerId: string,
  _previous: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  const active = await requireActiveTenant(tenantId);

  const raw = Object.fromEntries(FIELDS.map((name) => [name, readText(formData, name)]));
  if (!ROLES_THAT_CAN_WRITE.includes(active.role)) {
    return { status: "error", message: NO_PERMISSION_EDIT, values: raw };
  }
  if (!isUuid(customerId)) {
    return { status: "error", message: "No encontramos a este cliente.", values: raw };
  }

  const parsed = customerSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  }

  const current = await getCustomer(active, customerId);
  if (current === null) {
    return { status: "error", message: "No encontramos a este cliente.", values: raw };
  }
  if (current === "unreadable") {
    return {
      status: "error",
      message: "No pudimos leer los datos actuales de este cliente. Avisa al equipo de soporte.",
      values: raw,
    };
  }

  const identityChanged = parsed.data.rut !== current.rut || parsed.data.email !== current.email;
  if (identityChanged && readText(formData, "confirmDuplicate") !== "1") {
    const duplicates = await findDuplicates(active, parsed.data, customerId);
    if (duplicates.length > 0) return { status: "error", duplicates, values: raw };
  }

  const row = buildCustomerChangeRow(parsed.data, current, active.tenantId, customerId);
  // Sin cambios no se toca la base: no queda un "cambio" vacío en la auditoría.
  if (Object.keys(row).length === 0) {
    redirect(`${tenantPath(active.tenantId, `clientes/${customerId}`)}?editado=1`);
  }
  // `select` devuelve las filas tocadas: si la base no dejó editar (rol, otra organización), llega vacío.
  const { data, error } = await active.supabase
    .from("customers")
    .update(row)
    .eq("tenant_id", active.tenantId)
    .eq("id", customerId)
    .select("id");
  if (error) {
    await serverLog("error", "customer_update_failed", { code: error.code });
    return {
      status: "error",
      message:
        error.code === SQLSTATE_INSUFFICIENT_PRIVILEGE
          ? NO_PERMISSION_EDIT
          : "No pudimos guardar los cambios. Intenta de nuevo en unos minutos.",
      values: raw,
    };
  }
  if (!data || data.length === 0) {
    return { status: "error", message: NO_PERMISSION_EDIT, values: raw };
  }

  redirect(`${tenantPath(active.tenantId, `clientes/${customerId}`)}?editado=1`);
}

/**
 * Buscar clientes. El término no viaja en la dirección: se guarda unos minutos en una cookie del
 * servidor y la lista lo lee de ahí (`search-cookie.ts`).
 */
export async function searchCustomersAction(tenantId: string, formData: FormData): Promise<void> {
  const active = await requireActiveTenant(tenantId);
  const term = readText(formData, "q");
  const base = tenantPath(active.tenantId, "clientes");
  if (term.trim() === "") {
    await clearCustomerSearch(active.tenantId);
    redirect(base);
  }
  await saveCustomerSearch(active.tenantId, term);
  redirect(`${base}?${SEARCH_ACTIVE_PARAM}=1`);
}

/** "Limpiar búsqueda": borra el término guardado y vuelve a la lista completa. */
export async function clearCustomerSearchAction(tenantId: string): Promise<void> {
  const active = await requireActiveTenant(tenantId);
  await clearCustomerSearch(active.tenantId);
  redirect(tenantPath(active.tenantId, "clientes"));
}
