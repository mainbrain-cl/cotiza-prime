// Registro único de la prueba de aislamiento (H-012). Es lo que hay que actualizar cuando alguien
// agrega una tabla, una función o una ruta: `registry-guard.test.ts` falla si se olvida.
//
// Sin dependencias pesadas, para que también lo lea Playwright.
import { randomUUID } from "node:crypto";
import type { IsolationFixture, PersonaKey, Role } from "./fixture";

/**
 * Quién puede ver cada fila de una tabla:
 * - `business`: solo filas de la organización activa (y, si se declara, solo ciertos roles).
 * - `selector-tenants`: las organizaciones de las que la persona es miembro (el selector).
 * - `selector-members`: sus propias membresías, más las de la organización activa.
 * - `profiles`: su propio perfil y el de quienes son miembros de la organización activa.
 * - `own-user`: solo filas con su `user_id`.
 * - `public`: cualquiera, hasta sin sesión (los términos vigentes).
 * - `server-only`: nadie con pase; solo la llave maestra del servidor.
 */
export type Visibility =
  | "business"
  | "selector-tenants"
  | "selector-members"
  | "profiles"
  | "own-user"
  | "public"
  | "server-only";

export interface TableSpec {
  name: string;
  visibility: Visibility;
  /** Roles que leen filas de la organización activa (todos si falta). */
  rolesThatRead?: Role[];
  /** Columna con la que se busca "una fila por su identificador". */
  idColumn: string;
  /** SQL (después de `where`) de las filas que "son de B" y no deben cambiar jamás. */
  ownedByB: (fx: IsolationFixture) => string;
  /** Columnas que un pase puede leer: para el control positivo y como alternativa a `*`. */
  readColumns: string;
  /** Cuerpo de un intento de crear una fila apuntando a otra organización. */
  insertAttack: (fx: IsolationFixture, targetTenant: string, marker: string) => object;
  /** Cambio de un intento de editar una fila ajena (o propia sin permiso). */
  updateAttack: (marker: string) => object;
  /** ¿La fixture tiene al menos una fila de B en esta tabla? (G2) */
  hasFixtureRowsInB: boolean;
}

const byTenantB = (fx: IsolationFixture) => `tenant_id = '${fx.orgs.B.tenantId}'`;

export const ISOLATION_TABLES: TableSpec[] = [
  {
    name: "customers",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,display_name",
    insertAttack: (_fx, tenant, marker) => ({
      id: randomUUID(),
      tenant_id: tenant,
      kind: "person",
      display_name: marker,
    }),
    updateAttack: (marker) => ({ display_name: marker }),
    hasFixtureRowsInB: true,
  },
  {
    name: "catalog_items",
    visibility: "business",
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,name,unit_price_clp",
    insertAttack: (_fx, tenant, marker) => ({
      id: randomUUID(),
      tenant_id: tenant,
      name: marker,
      unit: "service",
      unit_price_clp: 1,
    }),
    updateAttack: (marker) => ({ name: marker }),
    hasFixtureRowsInB: true,
  },
  {
    name: "numbering_settings",
    visibility: "business",
    idColumn: "tenant_id",
    ownedByB: byTenantB,
    readColumns: "tenant_id,prefix,mode",
    insertAttack: (_fx, tenant, marker) => ({ tenant_id: tenant, prefix: marker.slice(0, 8) }),
    updateAttack: () => ({ prefix: "ATAQUE" }),
    hasFixtureRowsInB: true,
  },
  {
    name: "numbering_sequences",
    visibility: "business",
    idColumn: "scope",
    ownedByB: byTenantB,
    readColumns: "tenant_id,scope,last_number",
    insertAttack: (_fx, tenant) => ({ tenant_id: tenant, scope: "continuous", last_number: 0 }),
    updateAttack: () => ({ last_number: 0 }),
    hasFixtureRowsInB: true,
  },
  {
    name: "audit_log",
    visibility: "business",
    rolesThatRead: ["owner", "admin"],
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,action,resource_type",
    insertAttack: (_fx, tenant, marker) => ({
      tenant_id: tenant,
      actor_type: "user",
      action: "ataque.registro",
      result: "success",
      details: { marker },
    }),
    updateAttack: (marker) => ({ details: { marker } }),
    hasFixtureRowsInB: true,
  },
  {
    name: "tenants",
    visibility: "selector-tenants",
    idColumn: "tenant_id",
    ownedByB: byTenantB,
    readColumns: "tenant_id,name,status",
    insertAttack: (_fx, tenant, marker) => ({ tenant_id: tenant, name: marker, rut: "76086428-5" }),
    updateAttack: (marker) => ({ name: marker }),
    hasFixtureRowsInB: true,
  },
  {
    name: "members",
    visibility: "selector-members",
    idColumn: "id",
    ownedByB: byTenantB,
    readColumns: "id,tenant_id,user_id,role",
    insertAttack: (fx, tenant) => ({
      tenant_id: tenant,
      user_id: fx.personas.ana.userId,
      role: "owner",
    }),
    updateAttack: () => ({ role: "owner" }),
    hasFixtureRowsInB: true,
  },
  {
    name: "profiles",
    visibility: "profiles",
    idColumn: "user_id",
    ownedByB: (fx) => `user_id = '${fx.personas.beto.userId}'`,
    // Sin `last_tenant_id`: esa columna es privada de cada persona (migración 9).
    readColumns: "user_id,tenant_id,full_name",
    insertAttack: (fx, _tenant, marker) => ({ user_id: fx.personas.ana.userId, full_name: marker }),
    updateAttack: (marker) => ({ full_name: marker }),
    hasFixtureRowsInB: true,
  },
  {
    name: "legal_acceptances",
    visibility: "own-user",
    idColumn: "id",
    ownedByB: (fx) => `user_id = '${fx.personas.beto.userId}'`,
    readColumns: "id,tenant_id,user_id,document_id",
    insertAttack: (fx) => ({ user_id: fx.personas.beto.userId, context: "reaccept" }),
    updateAttack: () => ({ context: "signup" }),
    hasFixtureRowsInB: true,
  },
  {
    name: "legal_documents",
    visibility: "public",
    idColumn: "id",
    ownedByB: () => "true",
    readColumns: "id,tenant_id,kind,version",
    insertAttack: (_fx, _tenant, marker) => ({
      kind: "terms",
      version: marker,
      content_sha256: "0".repeat(64),
      published_at: new Date().toISOString(),
    }),
    updateAttack: () => ({ is_current: false }),
    hasFixtureRowsInB: false,
  },
  {
    name: "auth_rate_limits",
    visibility: "server-only",
    idColumn: "key_hash",
    ownedByB: () => "true",
    readColumns: "scope,key_hash,failures",
    insertAttack: (_fx, _tenant, marker) => ({
      scope: "login_ip",
      key_hash: "f".repeat(63) + (marker.length % 10),
    }),
    updateAttack: () => ({ failures: 0 }),
    hasFixtureRowsInB: false,
  },
];

/** Cómo se llama a una función expuesta por la API (RPC) y qué se espera de ella. */
export interface RpcCase {
  /** Argumentos válidos de una llamada normal. */
  args: object;
  /** ¿Escribe datos de la organización activa? Entonces con una organización ajena debe fallar. */
  writesActiveTenant: boolean;
}

export const RPC_CASES: Record<string, RpcCase> = {
  set_numbering: {
    args: { p_prefix: "ATAQUE", p_mode: "yearly", p_start_number: 9999 },
    writesActiveTenant: true,
  },
  preview_next_quote_number: { args: {}, writesActiveTenant: false },
  accept_current_legal_documents: { args: {}, writesActiveTenant: false },
  create_tenant: {
    args: { p_name: "Negocio de ataque", p_rut: "76086428-5" },
    writesActiveTenant: false,
  },
  my_last_tenant_id: { args: {}, writesActiveTenant: false },
};

/** Funciones de `public` que solo ejecuta el servidor con la llave maestra: nadie con pase las llama. */
export const SERVER_ONLY_FUNCTIONS = [
  "auth_limit_locked_until",
  "auth_limit_record_failure",
  "auth_limit_clear",
];

/** Una dirección de la aplicación (pantalla o API) y cómo se prueba. */
export interface AppRoute {
  /** Como la escribe Next.js, p. ej. `/o/[tenantId]/clientes/[customerId]`. */
  path: string;
  kind: "page" | "api";
  /** Sin organización ni sesión: no hay nada que aislar (p. ej. `/api/v1/ping`). */
  public?: boolean;
}

export const APP_ROUTES: AppRoute[] = [
  { path: "/api/v1/ping", kind: "api", public: true },
  { path: "/o/[tenantId]", kind: "page" },
  { path: "/o/[tenantId]/catalogo", kind: "page" },
  { path: "/o/[tenantId]/clientes", kind: "page" },
  { path: "/o/[tenantId]/clientes/nuevo", kind: "page" },
  { path: "/o/[tenantId]/clientes/[customerId]", kind: "page" },
  { path: "/o/[tenantId]/configuracion", kind: "page" },
  { path: "/o/[tenantId]/configuracion/numeracion", kind: "page" },
  { path: "/o/[tenantId]/cotizaciones", kind: "page" },
];

/** Dirección concreta de una ruta de pantalla para una organización (y un cliente, si lo pide). */
export function concretePath(route: AppRoute, tenantId: string, customerId: string): string {
  return route.path.replace("[tenantId]", tenantId).replace("[customerId]", customerId);
}

/** Personas con acceso de lectura a una organización, según el rol. */
export function canReadRole(spec: TableSpec, role: Role | null): boolean {
  if (role === null) return false;
  return spec.rolesThatRead ? spec.rolesThatRead.includes(role) : true;
}

export type { PersonaKey };
