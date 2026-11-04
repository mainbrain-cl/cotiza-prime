import "server-only";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid } from "@/lib/tenant/constants";
import { SNIPPETS_MAX_PER_TENANT, isSnippetKind } from "./model";
import { groupSnippets, type SnippetGroup, type SnippetRow } from "./groups";

type StoredSnippet = {
  id: string;
  kind: string;
  name: string;
  body: string;
  is_default: boolean;
  revision: number;
  updated_at: string;
};

const COLUMNS = "id, kind, name, body, is_default, revision, updated_at";

function toRow(stored: StoredSnippet): SnippetRow | null {
  // Un tipo que la aplicación no conoce no se muestra (no debería existir: la base lo impide).
  if (!isSnippetKind(stored.kind)) return null;
  return {
    id: stored.id,
    kind: stored.kind,
    name: stored.name,
    body: stored.body,
    isDefault: stored.is_default,
    revision: stored.revision,
    updatedAt: stored.updated_at,
  };
}

export type SnippetList = { ok: true; groups: SnippetGroup[]; total: number } | { ok: false };

/**
 * Los textos guardados de la organización activa, agrupados por tipo y ordenados por nombre. Los lee cualquier
 * miembro (política `text_snippets_select`); la pantalla de Configuración además exige `settings.manage` ANTES
 * de llamar aquí. Corre con el pase de la persona, nunca con la llave maestra.
 */
export async function loadSnippets(active: ActiveTenant): Promise<SnippetList> {
  const { data, error } = await active.supabase
    .from("text_snippets")
    .select(COLUMNS)
    .eq("tenant_id", active.tenantId)
    .order("name", { ascending: true })
    // El tope por organización es 50: este margen alcanza siempre.
    .limit(SNIPPETS_MAX_PER_TENANT * 2);
  if (error || !data) {
    await serverLog("error", "snippets_list_failed", { code: error?.code });
    return { ok: false };
  }
  const rows = (data as StoredSnippet[]).flatMap((stored) => toRow(stored) ?? []);
  return { ok: true, groups: groupSnippets(rows), total: rows.length };
}

export type SnippetLookup =
  { status: "found"; row: SnippetRow } | { status: "missing" } | { status: "error" };

/**
 * Un texto por su identificador. «No existe» y «es de otra organización» dan lo mismo (`missing`): la base
 * filtra por la organización activa y aquí además se compara el `tenant_id`.
 */
export async function loadSnippet(active: ActiveTenant, id: string): Promise<SnippetLookup> {
  if (!isUuid(id)) return { status: "missing" };
  const { data, error } = await active.supabase
    .from("text_snippets")
    .select(COLUMNS)
    .eq("tenant_id", active.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    await serverLog("error", "snippet_read_failed", { code: error.code });
    return { status: "error" };
  }
  const row = data ? toRow(data as StoredSnippet) : null;
  return row ? { status: "found", row } : { status: "missing" };
}
