import "server-only";
import { serverLog } from "@/lib/log/server-log";
import { can } from "@/lib/permissions/matrix";
import type { ActiveTenant, MemberRole } from "@/lib/tenant/active-tenant";
import { isUuid } from "@/lib/tenant/constants";
import { isKnownAuditAction } from "./labels";

/** Registros por página. */
export const AUDIT_PAGE_SIZE = 25;
const PGRST_RANGE_NOT_SATISFIABLE = "PGRST103";

/**
 * Quién ve el registro de actividad: solo el Dueño (H-014, supuesto 13 del sprint 5). Lo decide la
 * matriz (`audit.read`) y la base de datos lo exige igual en la política `audit_select`.
 */
export function canViewAuditLog(role: MemberRole): boolean {
  return can(role, "audit.read");
}

export type AuditEntry = {
  id: number;
  occurredAt: string;
  actorType: "user" | "service" | "system" | "public";
  /** Nombre de quien lo hizo; `null` si no hay persona o ya no es parte del equipo. */
  actorName: string | null;
  /**
   * Nombre de la persona del equipo sobre la que se hizo la acción (cuando el recurso es un miembro: cambiarle el rol,
   * quitarla…); `null` si no se puede leer. Se resuelve al leer, con `members` y `profiles`: no se guarda en la auditoría.
   */
  subjectName: string | null;
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
  resource_id: string | null;
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

/**
 * Las personas que tienen o tuvieron una fila en el equipo: su nombre (desde H-010 también se lee el de quien ya no
 * está) y de qué persona es cada fila de `members` (el recurso de `member.role_changed` y `member.removed`).
 */
async function memberDirectory(active: ActiveTenant): Promise<{
  names: Map<string, string>;
  userOfMember: Map<string, string>;
}> {
  const names = new Map<string, string>();
  const userOfMember = new Map<string, string>();
  const { data: members } = await active.supabase
    .from("members")
    .select("id, user_id")
    .eq("tenant_id", active.tenantId);
  const rows = (members ?? []) as { id?: string; user_id: string }[];
  for (const row of rows) if (row.id) userOfMember.set(row.id, row.user_id);
  const ids = [...new Set(rows.map((row) => row.user_id))];
  if (ids.length === 0) return { names, userOfMember };
  const { data: profiles } = await active.supabase
    .from("profiles")
    .select("user_id, full_name")
    .in("user_id", ids);
  for (const row of (profiles ?? []) as { user_id: string; full_name: string }[]) {
    names.set(row.user_id, row.full_name);
  }
  return { names, userOfMember };
}

/** El nombre de la persona afectada, solo si el recurso es un miembro de ESTA organización y su perfil se puede leer. */
function subjectNameOf(
  row: AuditRow,
  names: Map<string, string>,
  userOfMember: Map<string, string>,
): string | null {
  if (row.resource_type !== "member" || !row.resource_id) return null;
  const userId = userOfMember.get(row.resource_id);
  return userId ? names.get(userId)?.trim() || null : null;
}

/** Las personas por las que se puede filtrar, ordenadas por nombre. */
export async function listAuditActors(active: ActiveTenant): Promise<AuditActorOption[]> {
  if (!canViewAuditLog(active.role)) return [];
  const { names } = await memberDirectory(active);
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
      "id, occurred_at, actor_type, actor_user_id, action, resource_type, resource_id, result, origin_ip, details",
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
  const { names, userOfMember } = await memberDirectory(active);
  const total = count ?? rows.length;
  return {
    entries: rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      actorType: row.actor_type,
      actorName: row.actor_user_id ? (names.get(row.actor_user_id) ?? null) : null,
      subjectName: subjectNameOf(row, names, userOfMember),
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
