"use server";

import { revalidatePath } from "next/cache";
import { serverLog } from "@/lib/log/server-log";
import { NO_PERMISSION_MESSAGE } from "@/lib/permissions/matrix";
import { requirePermission } from "@/lib/permissions/require";
import { isValidMaxDiscountBp } from "@/lib/quotes/line-rules";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import {
  DISCOUNT_CAP_GENERIC_FAILURE,
  DISCOUNT_CAP_INVALID_MESSAGE,
  DISCOUNT_CAP_SAVED_MESSAGE,
  DISCOUNT_CAP_UNCHANGED_MESSAGE,
  type DiscountCapResult,
} from "./discount-cap-messages";

/**
 * H-041: fija el descuento máximo de los Comerciales. Orden: organización activa → permiso `catalog.manage` (sin él no se consulta
 * nada) → forma del valor → `public.set_quote_max_discount`, que vuelve a exigir el permiso y el rango en la base y deja el valor
 * anterior y el nuevo en la auditoría de la organización. Con el pase de la persona, nunca con la llave maestra. Nada de lo que
 * se escribe llega a un log: solo códigos.
 */

const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";
const SQLSTATE_INVALID = "CP422";

export async function saveDiscountCapAction(
  tenantId: string,
  maxDiscountBp: number | null,
): Promise<DiscountCapResult> {
  const active = await requireActiveTenant(tenantId);

  const denied = requirePermission(active, "catalog.manage");
  if (denied) return { status: "error", message: denied };
  if (!isValidMaxDiscountBp(maxDiscountBp)) {
    return { status: "error", message: DISCOUNT_CAP_INVALID_MESSAGE };
  }

  const { data, error } = await active.supabase.rpc("set_quote_max_discount", {
    p_max_bp: maxDiscountBp,
  });
  if (error) {
    if (error.code === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
      return { status: "error", message: NO_PERMISSION_MESSAGE };
    }
    if (error.code === SQLSTATE_INVALID) {
      return { status: "error", message: DISCOUNT_CAP_INVALID_MESSAGE };
    }
    await serverLog("error", "set_quote_max_discount_failed", { code: error.code });
    return { status: "error", message: DISCOUNT_CAP_GENERIC_FAILURE };
  }

  const saved = data as { changed?: unknown; max_discount_bp?: unknown } | null;
  if (
    !saved ||
    typeof saved.changed !== "boolean" ||
    !isValidMaxDiscountBp(saved.max_discount_bp ?? null)
  ) {
    await serverLog("error", "set_quote_max_discount_failed", { code: "shape" });
    return { status: "error", message: DISCOUNT_CAP_GENERIC_FAILURE };
  }
  revalidatePath(tenantPath(active.tenantId, "catalogo"), "layout");
  revalidatePath(tenantPath(active.tenantId, "cotizaciones"), "layout");
  return {
    status: "ok",
    message: saved.changed ? DISCOUNT_CAP_SAVED_MESSAGE : DISCOUNT_CAP_UNCHANGED_MESSAGE,
    maxDiscountBp: (saved.max_discount_bp ?? null) as number | null,
  };
}
