import "server-only";
import { serverLog } from "@/lib/log/server-log";
import { canEver } from "@/lib/permissions/matrix";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { isApprovalMode, type ApprovalRule } from "./rule";

/**
 * La regla de aprobación VIGENTE de la organización activa (la versión más alta). La lee cualquier miembro (política
 * `approval_rules_select`): el Comercial necesita saber por qué su cotización queda bloqueada. Corre con el pase de la
 * persona, nunca con la llave maestra. Nada de esto va a un log salvo códigos de error.
 */

type StoredRule = {
  id: string;
  version: number;
  mode: string;
  amount_threshold_clp: number | string | null;
  discount_threshold_bp: number | null;
  created_by: string | null;
  created_at: string;
};

const COLUMNS =
  "id, version, mode, amount_threshold_clp, discount_threshold_bp, created_by, created_at";

export type CurrentApprovalRule = {
  id: string;
  version: number;
  rule: ApprovalRule;
  createdAt: string;
  /** Quién la dejó así; `null` en la versión inicial, que crea el sistema («Nunca»). */
  createdBy: string | null;
};

function toRule(stored: StoredRule): CurrentApprovalRule | null {
  if (!isApprovalMode(stored.mode)) return null;
  const amount = stored.amount_threshold_clp === null ? null : Number(stored.amount_threshold_clp);
  if (amount !== null && !Number.isSafeInteger(amount)) return null;
  return {
    id: stored.id,
    version: stored.version,
    rule: {
      mode: stored.mode,
      amountThresholdClp: amount,
      discountThresholdBp: stored.discount_threshold_bp,
    },
    createdAt: stored.created_at,
    createdBy: stored.created_by,
  };
}

export type ApprovalRuleLookup =
  { status: "ok"; current: CurrentApprovalRule } | { status: "missing" } | { status: "error" };

export async function loadCurrentApprovalRule(active: ActiveTenant): Promise<ApprovalRuleLookup> {
  const { data, error } = await active.supabase
    .from("approval_rules")
    .select(COLUMNS)
    .eq("tenant_id", active.tenantId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    await serverLog("error", "approval_rule_read_failed", { code: error.code });
    return { status: "error" };
  }
  if (!data) {
    // Toda organización nace con su versión 1: que falte es un daño, no una pantalla vacía.
    await serverLog("error", "approval_rule_missing", { code: "no_rows" });
    return { status: "missing" };
  }
  const current = toRule(data as StoredRule);
  if (!current) {
    await serverLog("error", "approval_rule_read_failed", { code: "shape" });
    return { status: "error" };
  }
  return { status: "ok", current };
}

/** El nombre de quien dejó la regla así, para «Último cambio: … por Nombre». `null` si no se puede leer. */
export async function loadRuleAuthorName(
  active: ActiveTenant,
  userId: string | null,
): Promise<string | null> {
  if (userId === null) return null;
  const { data } = await active.supabase
    .from("profiles")
    .select("full_name")
    .eq("user_id", userId)
    .maybeSingle();
  const name = (data as { full_name: string } | null)?.full_name?.trim();
  return name ? name : null;
}

/**
 * Cuántos miembros activos pueden aprobar cotizaciones (el rol alcanza para `quote.approve`). El aviso «nadie más puede
 * aprobar» de la pantalla de la regla lo usa. `null` si no se pudo contar. Los nombres de los roles viven solo en la matriz.
 */
export async function countActiveApprovers(active: ActiveTenant): Promise<number | null> {
  const { data, error } = await active.supabase
    .from("members")
    .select("role")
    .eq("tenant_id", active.tenantId)
    .eq("status", "active");
  if (error || !data) {
    await serverLog("error", "approvers_count_failed", { code: error?.code });
    return null;
  }
  return (data as { role: string }[]).filter((member) => canEver(member.role, "quote.approve"))
    .length;
}
