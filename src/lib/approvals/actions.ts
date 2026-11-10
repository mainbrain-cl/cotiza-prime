"use server";

import { revalidatePath } from "next/cache";
import { fieldErrorsOf } from "@/lib/auth/schemas";
import { serverLog } from "@/lib/log/server-log";
import { NO_PERMISSION_MESSAGE } from "@/lib/permissions/matrix";
import { requirePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import type { ApprovalSaveState } from "./form-state";
import { approvalRuleSchema } from "./schemas";

/**
 * Guardar la regla de aprobación (H-040). Resuelve la organización activa, exige `settings.manage` con la matriz ANTES de tocar
 * la base y recién entonces valida y llama a `set_approval_rule`, que vuelve a exigir el permiso y revisa todo en la base
 * (42501 sin permiso, CP409 otra persona cambió la regla, CP422 dato inválido). Con el pase de la persona, nunca la llave
 * maestra. Nada de lo que se escribe llega a un log: solo códigos.
 */

const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";
const SQLSTATE_CONFLICT = "CP409";
const SQLSTATE_INVALID = "CP422";

export const APPROVAL_CONFLICT_MESSAGE =
  "Otra persona cambió la regla mientras la editabas. Recarga para ver la vigente.";
export const APPROVAL_UNCHANGED_MESSAGE = "La regla ya estaba así: no hay cambios que guardar.";
export const APPROVAL_SAVED_MESSAGE = "Guardamos la regla de aprobación.";
export const APPROVAL_GENERIC_FAILURE =
  "No pudimos guardar la regla. Intenta de nuevo en unos minutos.";

const SETTINGS_PATH = "configuracion/aprobaciones";

function readText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

type SavedRule = { changed: boolean; version: number };

function readSaved(data: unknown): SavedRule | null {
  if (typeof data !== "object" || data === null) return null;
  const { changed, version } = data as { changed?: unknown; version?: unknown };
  if (typeof changed !== "boolean" || typeof version !== "number" || !Number.isSafeInteger(version))
    return null;
  return { changed, version };
}

export async function saveApprovalRuleAction(
  tenantId: string,
  _previous: ApprovalSaveState,
  formData: FormData,
): Promise<ApprovalSaveState> {
  const active = await requireActiveTenant(tenantId);
  const values = {
    mode: readText(formData, "mode"),
    amount: readText(formData, "amount"),
    discount: readText(formData, "discount"),
  };

  const denied = requirePermission(active, "settings.manage");
  if (denied) return { status: "error", message: denied, values };

  const parsed = approvalRuleSchema.safeParse({
    ...values,
    expectedVersion: readText(formData, "expectedVersion"),
  });
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values };
  }
  const input = parsed.data;

  const { data, error } = await active.supabase.rpc("set_approval_rule", {
    p_expected_version: input.expectedVersion,
    p_mode: input.mode,
    p_amount_threshold_clp: input.amountThresholdClp,
    p_discount_threshold_bp: input.discountThresholdBp,
  });

  if (error) {
    if (error.code === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
      return { status: "error", message: NO_PERMISSION_MESSAGE, values };
    }
    if (error.code === SQLSTATE_CONFLICT) {
      return { status: "error", message: APPROVAL_CONFLICT_MESSAGE, conflict: true, values };
    }
    if (error.code === SQLSTATE_INVALID) {
      const reason = error.message ?? "";
      if (reason.startsWith("amount_out_of_range")) {
        return {
          status: "error",
          fieldErrors: { amount: "El monto es demasiado alto o muy bajo." },
          values,
        };
      }
      if (reason.startsWith("discount_out_of_range")) {
        return {
          status: "error",
          fieldErrors: { discount: "El descuento debe ser menor que 100%." },
          values,
        };
      }
      if (reason.startsWith("missing_condition")) {
        return {
          status: "error",
          fieldErrors: { condition: "Escribe un monto, un porcentaje de descuento o los dos." },
          values,
        };
      }
    }
    await serverLog("error", "set_approval_rule_failed", { code: error.code });
    return { status: "error", message: APPROVAL_GENERIC_FAILURE, values };
  }

  const saved = readSaved(data);
  if (!saved) {
    await serverLog("error", "set_approval_rule_failed", { code: "shape" });
    return { status: "error", message: APPROVAL_GENERIC_FAILURE, values };
  }
  revalidatePath(tenantPath(active.tenantId, SETTINGS_PATH));
  return {
    status: "saved",
    message: saved.changed ? APPROVAL_SAVED_MESSAGE : APPROVAL_UNCHANGED_MESSAGE,
    version: saved.version,
    values,
  };
}
