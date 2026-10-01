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
  /**
   * ¿Una persona con permiso puede crear y editar una fila PROPIA de esta tabla por la API?
   * Si sí, la prueba de escritura exige el control positivo: el mismo cuerpo apuntado a su propia
   * organización se acepta (así un rechazo no puede deberse a un cuerpo mal armado). Las demás
   * tablas se escriben solo por funciones o por el servidor.
   */
  ownWriteAccepted: boolean;
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
    ownWriteAccepted: true,
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
    ownWriteAccepted: true,
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
    ownWriteAccepted: false,
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
    ownWriteAccepted: false,
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
    ownWriteAccepted: false,
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
    ownWriteAccepted: false,
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
    ownWriteAccepted: false,
  },
  {
    name: "profiles",
    visibility: "profiles",
    idColumn: "user_id",
    ownedByB: (fx) => `user_id = '${fx.personas.beto.userId}'`,
    // Sin `last_tenant_id`: esa columna es privada de cada persona (migración 12).
    readColumns: "user_id,tenant_id,full_name",
    insertAttack: (fx, _tenant, marker) => ({ user_id: fx.personas.ana.userId, full_name: marker }),
    updateAttack: (marker) => ({ full_name: marker }),
    hasFixtureRowsInB: true,
    ownWriteAccepted: false,
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
    ownWriteAccepted: false,
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
    ownWriteAccepted: false,
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
    ownWriteAccepted: false,
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

/**
 * Qué tablas NO son "de negocio" y cómo se ven. Lista cerrada: toda otra tabla con `tenant_id`
 * debe declararse `business`. Así nadie puede esconder una tabla de negocio declarándola "public"
 * u "own-user" para que la prueba la trate con menos rigor. Agregar una entrada aquí es una
 * decisión de diseño que se revisa, no un trámite.
 */
export const NON_BUSINESS_VISIBILITY: Readonly<Record<string, Visibility>> = {
  legal_documents: "public",
  tenants: "selector-tenants",
  members: "selector-members",
  profiles: "profiles",
  legal_acceptances: "own-user",
  auth_rate_limits: "server-only",
};

/** Errores de declaración de visibilidad del registro (vacío si todo calza con la lista cerrada). */
export function visibilityDeclarationErrors(
  tables: readonly Pick<TableSpec, "name" | "visibility">[],
): string[] {
  const errors: string[] = [];
  for (const table of tables) {
    const expected = NON_BUSINESS_VISIBILITY[table.name] ?? "business";
    if (table.visibility !== expected) {
      errors.push(`${table.name}: declarada ${table.visibility}, debe ser ${expected}`);
    }
  }
  return errors;
}

/**
 * Una dirección de la aplicación (pantalla o ruta de servidor) y cómo se prueba.
 * - `tenant`: vive dentro de una organización (`/o/[tenantId]/...`) y exige `requireActiveTenant`.
 * - `none`: no hay organización que aislar (ingreso, registro, términos, `/api/v1/ping`, etc.).
 *   Cada una se declara a mano: una ruta nueva sin declarar rompe la guardia G5.
 */
export type RouteScope = "tenant" | "none";

export interface AppRoute {
  /** Como la escribe Next.js, p. ej. `/o/[tenantId]/clientes/[customerId]`. Sin grupos `(x)`. */
  path: string;
  /** `page` = page.*; `api` = route.* bajo `/api/v1`; `route` = otro route.* (p. ej. `/auth/callback`). */
  kind: "page" | "api" | "route";
  scope: RouteScope;
}

export const APP_ROUTES: AppRoute[] = [
  { path: "/", kind: "page", scope: "none" },
  { path: "/ingresar", kind: "page", scope: "none" },
  { path: "/registro", kind: "page", scope: "none" },
  { path: "/aceptar-terminos", kind: "page", scope: "none" },
  { path: "/recuperar-contrasena", kind: "page", scope: "none" },
  { path: "/restablecer-contrasena", kind: "page", scope: "none" },
  { path: "/organizaciones/nueva", kind: "page", scope: "none" },
  { path: "/privacidad", kind: "page", scope: "none" },
  { path: "/terminos", kind: "page", scope: "none" },
  { path: "/auth/callback", kind: "route", scope: "none" },
  { path: "/auth/recuperar", kind: "route", scope: "none" },
  { path: "/api/v1/ping", kind: "api", scope: "none" },
  { path: "/o/[tenantId]", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/catalogo", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/clientes", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/clientes/nuevo", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/clientes/[customerId]", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/configuracion", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/configuracion/numeracion", kind: "page", scope: "tenant" },
  { path: "/o/[tenantId]/cotizaciones", kind: "page", scope: "tenant" },
];

/** Pantallas dentro de una organización (las que se atacan con la dirección de otra). */
export const TENANT_PAGES = APP_ROUTES.filter((r) => r.kind === "page" && r.scope === "tenant");

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
