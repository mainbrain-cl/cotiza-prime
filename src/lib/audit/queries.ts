import "server-only";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant, MemberRole } from "@/lib/tenant/active-tenant";
import { isUuid } from "@/lib/tenant/constants";
import { isKnownAuditAction } from "./labels";

/** Registros por página. */
export const AUDIT_PAGE_SIZE = 25;
const PGRST_RANGE_NOT_SATISFIABLE = "PGRST103";

/**
 * Quién ve el registro de actividad: solo el Dueño (H-014). La base de datos también deja leerlo al
 * Administrador (política de la migración 3); esta pantalla es más estricta a propósito.
 */
const AUDIT_VIEWER_ROLES: readonly MemberRole[] = ["owner"];

export function canViewAuditLog(role: MemberRole): boolean {
  return AUDIT_VIEWER_ROLES.includes(role);
}

export type AuditEntry = {
  id: number;
  occurredAt: string;
  actorType: "user" | "service" | "system" | "public";
  /** Nombre de quien lo hizo; `null` si no hay persona o ya no es parte del equipo. */
  actorName: string | null;
  action: string;
  resourceType: string | null;
  result: "success" | "failure" | "denied";
  originIp: string | null;
  details: unknown;
};

export type AuditActorOption = { userId: string; name: string };

export type AuditPage = {
  entries: AuditEntry[];
  page: number;
  pageCount: number;
  total: number;
};

export type AuditFilters = {
  /** Persona (`user_id`). Un valor que no es un UUID se ignora. */
  actor?: string | null;
  /** Acción de la lista conocida. Cualquier otro valor se ignora. */
  action?: string | null;
  page?: number;
};

type AuditRow = {
  id: number;
  occurred_at: string;
  actor_type: AuditEntry["actorType"];
  actor_user_id: string | null;
  action: string;
  resource_type: string | null;
  result: AuditEntry["result"];
  origin_ip: string | null;
  details: unknown;
};

/** Valores de los filtros ya limpios: lo que no se reconoce, no filtra. */
export function sanitizeAuditFilters(filters: AuditFilters): {
  actor: string | null;
  action: string | null;
  page: number;
} {
  const actor = filters.actor && isUuid(filters.actor) ? filters.actor.toLowerCase() : null;
  const action = filters.action && isKnownAuditAction(filters.action) ? filters.action : null;
  const page = Number.isInteger(filters.page) && (filters.page ?? 0) >= 1 ? filters.page! : 1;
  return { actor, action, page };
}

/** Nombres de las personas que aparecen en el equipo (los de quienes ya no están no se pueden leer). */
async function memberNames(active: ActiveTenant): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const { data: members } = await active.supabase
    .from("members")
    .select("user_id")
    .eq("tenant_id", active.tenantId);
  const ids = [...new Set(((members ?? []) as { user_id: string }[]).map((row) => row.user_id))];
  if (ids.length === 0) return names;
  const { data: profiles } = await active.supabase
    .from("profiles")
    .select("user_id, full_name")
    .in("user_id", ids);
  for (const row of (profiles ?? []) as { user_id: string; full_name: string }[]) {
    names.set(row.user_id, row.full_name);
  }
  return names;
}

/** Las personas por las que se puede filtrar, ordenadas por nombre. */
export async function listAuditActors(active: ActiveTenant): Promise<AuditActorOption[]> {
  if (!canViewAuditLog(active.role)) return [];
  const names = await memberNames(active);
  return [...names.entries()]
    .map(([userId, name]) => ({ userId, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "es-CL"));
}

/**
 * El registro de actividad de la organización activa, lo más reciente primero. Solo el Dueño: si
 * quien pregunta no lo es, no se consulta nada. Las filas las filtra además la base (RLS), así que
 * ni con un error aquí se verían las de otra organización. Devuelve `null` si falla la consulta.
 */
export async function listAuditEntries(
  active: ActiveTenant,
  filters: AuditFilters = {},
): Promise<AuditPage | null> {
  if (!canViewAuditLog(active.role)) return null;
  const { actor, action, page } = sanitizeAuditFilters(filters);
  const from = (page - 1) * AUDIT_PAGE_SIZE;

  let query = active.supabase
    .from("audit_log")
    .select(
      "id, occurred_at, actor_type, actor_user_id, action, resource_type, result, origin_ip, details",
      { count: "exact" },
    )
    .eq("tenant_id", active.tenantId);
  if (actor) query = query.eq("actor_user_id", actor);
  if (action) query = query.eq("action", action);
  const { data, error, count } = await query
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + AUDIT_PAGE_SIZE - 1);

  // Una página que ya no existe (p. ej. un enlace viejo): se muestra la primera.
  if (error?.code === PGRST_RANGE_NOT_SATISFIABLE && page > 1) {
    return listAuditEntries(active, { ...filters, page: 1 });
  }
  if (error || !data) {
    await serverLog("error", "audit_list_failed", { code: error?.code });
    return null;
  }

  const rows = data as unknown as AuditRow[];
  const names = await memberNames(active);
  const total = count ?? rows.length;
  return {
    entries: rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      actorType: row.actor_type,
      actorName: row.actor_user_id ? (names.get(row.actor_user_id) ?? null) : null,
      action: row.action,
      resourceType: row.resource_type,
      result: row.result,
      originIp: row.origin_ip,
      details: row.details,
    })),
    page,
    pageCount: Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)),
    total,
  };
}
