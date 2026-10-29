"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/lib/auth/form-state";
import { fieldErrorsOf } from "@/lib/auth/schemas";
import { serverLog } from "@/lib/log/server-log";
import { NO_PERMISSION_MESSAGE } from "@/lib/permissions/matrix";
import { requirePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { createCatalogItemSchema } from "./schemas";

const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";

function readText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * H-020: agrega un servicio al catálogo de la organización activa. Valida en el servidor.
 * No manda `tenant_id`: lo pone la base según la organización activa, y la regla de seguridad por
 * fila (RLS) solo deja insertar al Dueño y a los Administradores.
 */
export async function createCatalogItemAction(
  tenantId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const active = await requireActiveTenant(tenantId);

  const raw = {
    name: readText(formData, "name"),
    description: readText(formData, "description"),
    unit: readText(formData, "unit"),
    unitPriceClp: readText(formData, "unitPriceClp"),
    taxTreatment: readText(formData, "taxTreatment"),
  };

  const denied = requirePermission(active, "catalog.manage");
  if (denied) return { status: "error", message: denied, values: raw };

  const parsed = createCatalogItemSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  }

  const { error } = await active.supabase.from("catalog_items").insert({
    name: parsed.data.name,
    description: parsed.data.description,
    unit: parsed.data.unit,
    unit_price_clp: parsed.data.unitPriceClp,
    tax_treatment: parsed.data.taxTreatment,
  });

  if (error) {
    if (error.code === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
      return {
        status: "error",
        message: NO_PERMISSION_MESSAGE,
        values: raw,
      };
    }
    await serverLog("error", "catalog_insert_failed", { code: error.code });
    return {
      status: "error",
      message: "No pudimos guardar el servicio. Intenta de nuevo en unos minutos.",
      values: raw,
    };
  }

  revalidatePath(tenantPath(active.tenantId, "catalogo"), "layout");
  // `nonce` hace que cada guardado sea distinto, para que el formulario se vacíe aunque se repita el nombre.
  return {
    status: "sent",
    message: `Agregaste "${parsed.data.name}" al catálogo.`,
    values: { nonce: crypto.randomUUID() },
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND_MESSAGE = "No encontramos este servicio. Puede que ya no exista en tu catálogo.";

/**
 * H-021: edita cualquier campo de un servicio. El servidor comprueba el rol y la base (RLS)
 * lo vuelve a comprobar. Un cambio de precio queda en la auditoría con el valor anterior y el nuevo.
 */
export async function updateCatalogItemAction(
  tenantId: string,
  itemId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const active = await requireActiveTenant(tenantId);

  const raw = {
    name: readText(formData, "name"),
    description: readText(formData, "description"),
    unit: readText(formData, "unit"),
    unitPriceClp: readText(formData, "unitPriceClp"),
    taxTreatment: readText(formData, "taxTreatment"),
  };

  const denied = requirePermission(active, "catalog.manage");
  if (denied) return { status: "error", message: denied, values: raw };
  if (!UUID_PATTERN.test(itemId)) {
    return { status: "error", message: NOT_FOUND_MESSAGE, values: raw };
  }

  const parsed = createCatalogItemSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  }

  const { data, error } = await active.supabase
    .from("catalog_items")
    .update({
      name: parsed.data.name,
      description: parsed.data.description,
      unit: parsed.data.unit,
      unit_price_clp: parsed.data.unitPriceClp,
      tax_treatment: parsed.data.taxTreatment,
    })
    .eq("id", itemId)
    .select("id");

  if (error) {
    if (error.code === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
      return {
        status: "error",
        message: NO_PERMISSION_MESSAGE,
        values: raw,
      };
    }
    await serverLog("error", "catalog_update_failed", { code: error.code });
    return {
      status: "error",
      message: "No pudimos guardar los cambios. Intenta de nuevo en unos minutos.",
      values: raw,
    };
  }
  if (!data || data.length === 0) {
    return { status: "error", message: NOT_FOUND_MESSAGE, values: raw };
  }

  revalidatePath(tenantPath(active.tenantId, "catalogo"), "layout");
  return {
    status: "sent",
    message: "Guardamos los cambios del servicio.",
    values: { nonce: crypto.randomUUID() },
  };
}

/** H-021: desactiva o reactiva un servicio. Nunca se borra: solo deja de ofrecerse al cotizar. */
export async function setCatalogItemActiveAction(
  tenantId: string,
  itemId: string,
  isActive: boolean,
): Promise<FormState> {
  const active = await requireActiveTenant(tenantId);

  const denied = requirePermission(active, "catalog.manage");
  if (denied) return { status: "error", message: denied };
  if (!UUID_PATTERN.test(itemId)) return { status: "error", message: NOT_FOUND_MESSAGE };

  const { data, error } = await active.supabase
    .from("catalog_items")
    .update({ is_active: isActive })
    .eq("id", itemId)
    .select("id");

  if (error) {
    if (error.code === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
      return { status: "error", message: NO_PERMISSION_MESSAGE };
    }
    await serverLog("error", "catalog_toggle_failed", { code: error.code });
    return {
      status: "error",
      message: "No pudimos cambiar el servicio. Intenta de nuevo en unos minutos.",
    };
  }
  if (!data || data.length === 0) return { status: "error", message: NOT_FOUND_MESSAGE };

  revalidatePath(tenantPath(active.tenantId, "catalogo"), "layout");
  return {
    status: "sent",
    message: isActive
      ? "Reactivaste el servicio: vuelve a aparecer al cotizar."
      : "Desactivaste el servicio: ya no aparece al cotizar, pero no se borró.",
    values: { nonce: crypto.randomUUID() },
  };
}
