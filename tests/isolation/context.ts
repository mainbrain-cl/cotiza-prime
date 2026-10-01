// Ayudas compartidas por los archivos de la prueba de aislamiento (solo bajo Vitest).
import type { Client } from "pg";
import { inject } from "vitest";
import { TENANT_HEADER } from "@/lib/tenant/constants";
import { connect } from "../db/helpers";
import { freshToken, type ExtraHeaders, type Session } from "../support/local-supabase";
import type { IsolationFixture, OrgKey, PersonaKey, Role } from "./fixture";
import { ORG_KEYS, PERSONA_KEYS } from "./fixture";
import type { TableSpec } from "./registry";

export function fixture(): IsolationFixture {
  return inject("fixture");
}

export const tenantOf = (key: OrgKey) => fixture().orgs[key].tenantId;
export const userOf = (key: PersonaKey) => fixture().personas[key].userId;

/** Cabecera de la organización activa; sin valor, no se manda cabecera alguna. */
export function tenantHeader(value: string | undefined): ExtraHeaders {
  return value === undefined ? {} : { [TENANT_HEADER]: value };
}

const sessions = new Map<PersonaKey, Session>();

/** Pase real vigente de una persona (se renueva con un inicio de sesión si le queda poco). */
export async function tokenOf(key: PersonaKey): Promise<string> {
  const persona = fixture().personas[key];
  const { session, token } = await freshToken(persona.email, sessions.get(key) ?? persona.session);
  sessions.set(key, session);
  return token;
}

/** Conexión directa a la base, solo para montar y verificar (jamás para atacar). */
export async function openDb(): Promise<Client> {
  return connect();
}

export interface LiveMembership {
  tenantId: string;
  role: Role;
  tenantActive: boolean;
}

/** Membresías activas de una persona, leídas en vivo: la verdad contra la que se compara el servidor. */
export async function liveMemberships(db: Client, userId: string): Promise<LiveMembership[]> {
  const { rows } = await db.query<{ tenant_id: string; role: Role; ok: boolean }>(
    `select m.tenant_id, m.role, (t.status = 'active' and t.kind = 'organization') as ok
     from public.members m join public.tenants t on t.tenant_id = m.tenant_id
     where m.user_id = $1 and m.status = 'active'`,
    [userId],
  );
  return rows.map((r) => ({ tenantId: r.tenant_id, role: r.role, tenantActive: r.ok }));
}

/**
 * Qué organización debería quedar activa con esta cabecera: la que nombra el valor SI la persona
 * es miembro activo de ella. Todo lo demás es "ninguna". Independiente de cómo lo resuelve la base.
 */
export async function expectedActive(
  db: Client,
  userId: string | null,
  headerValue: string | undefined,
): Promise<{ tenantId: string; role: Role } | null> {
  if (!userId || headerValue === undefined) return null;
  let parsed: string;
  try {
    // La base acepta las formas equivalentes de un UUID (mayúsculas, llaves, sin guiones).
    parsed = (await db.query<{ v: string }>(`select $1::uuid::text as v`, [headerValue])).rows[0].v;
  } catch {
    return null;
  }
  const hit = (await liveMemberships(db, userId)).find(
    (m) => m.tenantId === parsed && m.tenantActive,
  );
  return hit ? { tenantId: hit.tenantId, role: hit.role } : null;
}

/** Personas que alguna vez fueron miembros de esas organizaciones. */
export async function peopleOfOrgs(db: Client, tenantIds: string[]): Promise<Set<string>> {
  if (tenantIds.length === 0) return new Set();
  const { rows } = await db.query<{ user_id: string }>(
    `select distinct user_id from public.members where tenant_id = any($1::uuid[])`,
    [tenantIds],
  );
  return new Set(rows.map((r) => r.user_id));
}

/** Personas que hoy son miembros activos de una organización. */
export async function activeMembersOf(db: Client, tenantId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ user_id: string }>(
    `select user_id from public.members where tenant_id = $1 and status = 'active'`,
    [tenantId],
  );
  return new Set(rows.map((r) => r.user_id));
}

/** Huella de las filas "de B" de una tabla: cambia si alguien las toca. */
export async function fingerprint(db: Client, spec: TableSpec): Promise<string> {
  const { rows } = await db.query<{ h: string }>(
    `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h
     from public.${spec.name} t where ${spec.ownedByB(fixture())}`,
  );
  return rows[0].h;
}

/** Identificador de una fila de B en la tabla (para atacarla "por id"), o null si no hay. */
export async function aRowOfB(db: Client, spec: TableSpec): Promise<string | null> {
  const { rows } = await db.query<{ v: string }>(
    `select ${spec.idColumn}::text as v from public.${spec.name} t
     where ${spec.ownedByB(fixture())} order by 1 limit 1`,
  );
  return rows[0]?.v ?? null;
}

/** Cantidad de filas de una tabla que cumplen una condición SQL. */
export async function countWhere(db: Client, table: string, where: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::text as n from public.${table} where ${where}`,
  );
  return Number(rows[0].n);
}

/** Textos que, si aparecen en una respuesta, delatan una filtración. */
export function orgMarkers(key: OrgKey): string[] {
  const fx = fixture();
  return [fx.orgs[key].tenantId, fx.orgs[key].canary];
}

export { ORG_KEYS, PERSONA_KEYS };

/** ¿La respuesta fue un rechazo (error), o una lista vacía de lo que se intentó tocar? */
export function isRejectedOrEmpty(res: { status: number; json: unknown }): boolean {
  if (res.status >= 400) return true;
  return Array.isArray(res.json) ? res.json.length === 0 : res.json === null;
}
