import "server-only";
import { z } from "zod";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import {
  CATALOG_SCOPE_GENERIC_FAILURE,
  mapCatalogScopeError,
  type CatalogScopeErrorKind,
  type CatalogScopeMode,
  type SaveCatalogScopeInput,
} from "./catalog-scope-model";

/**
 * Guardar la regla de servicios de un miembro (H-042). Corre con el pase de la persona (nunca con la llave maestra); la base vuelve a
 * revisar el permiso y todas las reglas en `set_member_catalog_scope`. Ningún nombre llega a un log: solo códigos.
 */

export type CatalogScopeActionResult =
  | {
      status: "ok";
      /** `unchanged`: lo pedido ya estaba guardado (por ejemplo un doble clic). */
      result: "changed" | "unchanged";
      revision: number;
      mode: CatalogScopeMode;
      count: number;
    }
  | { status: "error"; kind: CatalogScopeErrorKind; message: string };

const savedSchema = z.object({
  result: z.enum(["changed", "unchanged"]),
  revision: z.number().int().min(0),
  mode: z.enum(["all", "list"]),
  count: z.number().int().min(0),
});

export async function saveCatalogScope(
  active: ActiveTenant,
  input: SaveCatalogScopeInput,
): Promise<CatalogScopeActionResult> {
  const { data, error } = await active.supabase.rpc("set_member_catalog_scope", {
    p_member_id: input.memberId,
    p_mode: input.mode,
    // los repetidos los deduplica la base, pero no hace falta mandarlos
    p_catalog_item_ids: input.mode === "list" ? [...new Set(input.itemIds)] : null,
    p_expected_revision: input.expectedRevision,
  });
  if (error) {
    const mapped = mapCatalogScopeError(error);
    // Solo el código: nunca el mensaje de la base ni datos de nadie. Los rechazos esperados no se registran.
    if (mapped.kind === "other") {
      void serverLog("error", "catalog_scope_save_failed", { code: error.code ?? "unknown" });
    }
    return { status: "error", kind: mapped.kind, message: mapped.message };
  }
  const parsed = savedSchema.safeParse(data);
  if (!parsed.success) {
    void serverLog("error", "catalog_scope_save_failed", { code: "shape" });
    return { status: "error", kind: "other", message: CATALOG_SCOPE_GENERIC_FAILURE };
  }
  return { status: "ok", ...parsed.data };
}
