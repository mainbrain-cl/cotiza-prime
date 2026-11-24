"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { saveCatalogScopeSchema } from "./catalog-scope-model";
import { saveCatalogScope, type CatalogScopeActionResult } from "./catalog-scope-service";

/**
 * Guarda los servicios que puede cotizar un miembro (H-042). Resuelve la organización activa, exige el permiso de equipo con la
 * matriz ANTES de tocar la base (si no lo tiene, la base ni se consulta) y recién entonces valida y guarda. La base vuelve a exigir el
 * permiso y todas las reglas. El resultado es un valor, nunca una excepción: un fallo no pierde lo que la persona estaba eligiendo.
 */
export async function saveCatalogScopeAction(
  tenantId: string,
  input: unknown,
): Promise<CatalogScopeActionResult> {
  const active = await requireActiveTenant(tenantId);
  const denied = requirePermission(active, "team.manage");
  if (denied) return { status: "error", kind: "forbidden", message: denied };

  const parsed = saveCatalogScopeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "error",
      kind: "invalid",
      message: parsed.error.issues[0]?.message ?? "Revisa lo que elegiste e intenta de nuevo.",
    };
  }
  const result = await saveCatalogScope(active, parsed.data);
  // Solo si funcionó: si falló (por ejemplo una versión vieja), la pantalla no se rehace para no taparle el aviso.
  if (result.status === "ok" && result.result === "changed") {
    revalidatePath(tenantPath(active.tenantId, "equipo"), "layout");
  }
  return result;
}
