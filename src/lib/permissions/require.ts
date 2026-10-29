/**
 * Cómo se EXIGE un permiso en el servidor (docs/arquitectura/sprint-5-equipo-y-permisos.md §3).
 *
 * - `requirePermission`: para las acciones de servidor y las rutas de la API. Devuelve `null` si la
 *   persona puede, o el mensaje único «No tienes permiso para esto.». Cada acción lo llama ANTES de
 *   tocar la base; si dice que no, no se consulta nada.
 * - `pagePermission`: para las pantallas. Devuelve `null` si puede, o la pantalla «No tienes permiso»
 *   lista para devolver. Se llama ANTES de leer cualquier dato.
 *
 * Quien no es miembro de la organización nunca llega aquí: `requireActiveTenant` ya le respondió
 * «No encontrado». «No tienes permiso» es solo para quien SÍ es miembro pero su rol no alcanza.
 *
 * Si NO se pasa `ctx`, la revisión es la gruesa: el rol alcanza si puede hacerlo sobre cualquier
 * recurso o sobre uno suyo. El detalle «¿es suyo?» lo exige después la base de datos. Si SÍ se pasa
 * `ctx`, la revisión es exacta, y un `isOwn` ausente o `undefined` cuenta como `false` (nunca se cae
 * a la revisión más amplia por un descuido).
 * Que la pantalla oculte un botón no es seguridad (PROYECTO.md §5.2).
 */
import "server-only";
import { createElement, type ReactElement } from "react";
import { NoPermission } from "@/components/permissions/no-permission";
import {
  can,
  canEver,
  NO_PERMISSION_MESSAGE,
  type PermissionAction,
  type PermissionContext,
} from "./matrix";

type WithRole = { readonly role: string };
type WithRoleAndTenant = WithRole & { readonly tenantId: string };

function allowed(
  role: string,
  action: PermissionAction,
  ctx: PermissionContext | undefined,
): boolean {
  return ctx === undefined
    ? canEver(role, action)
    : can(role, action, { isOwn: ctx.isOwn === true });
}

/** `null` si puede; si no, el mensaje único para devolver en el resultado de la acción. */
export function requirePermission(
  active: WithRole,
  action: PermissionAction,
  ctx?: PermissionContext,
): string | null {
  return allowed(active.role, action, ctx) ? null : NO_PERMISSION_MESSAGE;
}

/** `null` si puede; si no, la pantalla «No tienes permiso» (sin haber leído ningún dato). */
export function pagePermission(
  active: WithRoleAndTenant,
  action: PermissionAction,
  ctx?: PermissionContext,
): ReactElement | null {
  return allowed(active.role, action, ctx)
    ? null
    : createElement(NoPermission, { tenantId: active.tenantId });
}
