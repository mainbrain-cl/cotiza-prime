/**
 * ÚNICO lugar donde se resuelve la organización activa, es decir, el `tenant_id`
 * (STACK.md §5b, punto 4; PROYECTO.md §13.1; modelo-datos.md §2.3).
 *
 * Una persona puede pertenecer a varias organizaciones, así que el `tenant_id` NO sale del pase de
 * sesión: sale de la dirección (`/o/{tenantId}/...`) y aquí se verifica, en cada petición, que la
 * persona sea miembro activo. Quien no es miembro recibe "No encontrado" (404), nunca "Prohibido":
 * no se revela si la organización existe.
 *
 * Ningún otro archivo arma la cabecera de la organización ni decide de dónde sale el tenant.
 *
 * Dos capas:
 * - `resolveActiveTenant({ userId, requestedTenantId })`: el núcleo. No usa sesión ni `notFound()`,
 *   así que sirve para pantallas, rutas de API y pruebas. Devuelve `null` si no corresponde.
 * - `requireActiveTenant(requestedTenantId)`: para pantallas y acciones. Exige sesión y responde
 *   "No encontrado" ante cualquier `null`.
 */
import { notFound } from "next/navigation";
import { cache } from "react";
import { logAuditEvent } from "@/lib/audit/log";
import { requireUser, type SessionUser } from "@/lib/auth/session";
import { getRequestContext } from "@/lib/http/request-context";
import type { MemberRole } from "@/lib/permissions/matrix";
import { shouldLogTenantDenied } from "@/lib/security/login-rate-limit";
import { createClient } from "@/lib/supabase/server";
import {
  CLIENT_IP_HEADER,
  REQUEST_ID_HEADER,
  TENANT_HEADER,
  isCanonicalUuid,
  isUuid,
} from "./constants";

// Los roles viven en la matriz de permisos (`src/lib/permissions/matrix.ts`); aquí solo se reexporta el tipo.
export type { MemberRole };

export type Membership = {
  tenantId: string;
  name: string;
  role: MemberRole;
  /** Ruta del logo en Storage, si la organización tiene uno. */
  logoPath: string | null;
};

type ScopedClient = Awaited<ReturnType<typeof createClient>>;

export type ResolvedTenant = {
  tenantId: string;
  tenantName: string;
  role: MemberRole;
  userId: string;
  /** Cliente de Supabase con la organización activa ya puesta en la cabecera. */
  supabase: ScopedClient;
};

export type ActiveTenant = ResolvedTenant & { user: SessionUser };

type TenantRef = { name: string; logo_path: string | null };

type MembershipRow = {
  tenant_id: string;
  role: MemberRole;
  tenants: TenantRef | TenantRef[] | null;
};

function toMembership(row: MembershipRow): Membership {
  const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
  return {
    tenantId: row.tenant_id,
    name: tenant?.name ?? "",
    role: row.role,
    logoPath: tenant?.logo_path ?? null,
  };
}

/** Organizaciones a las que pertenece la persona (para el selector). */
export const listMemberships = cache(async (userId: string): Promise<Membership[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("members")
    .select("tenant_id, role, tenants!inner(name, logo_path, status, kind)")
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("tenants.status", "active")
    .eq("tenants.kind", "organization");
  if (error || !data) return [];
  return (data as unknown as MembershipRow[])
    .map(toMembership)
    .sort((a, b) => a.name.localeCompare(b.name, "es-CL"));
});

/**
 * Núcleo: ¿esta persona es miembro activo de la organización pedida? Si lo es, entrega el cliente de
 * Supabase con la cabecera puesta; si no (o si la dirección no es un UUID canónico en minúsculas),
 * deja constancia en la auditoría y devuelve `null`.
 */
export async function resolveActiveTenant(input: {
  userId: string;
  requestedTenantId: string;
}): Promise<ResolvedTenant | null> {
  const { userId, requestedTenantId } = input;

  const canonical = isCanonicalUuid(requestedTenantId);
  const membership = canonical
    ? (await listMemberships(userId)).find((m) => m.tenantId === requestedTenantId)
    : undefined;

  if (!membership) {
    // Tope por persona y ventana: quien prueba direcciones ajenas en bucle no llena la auditoría.
    // La respuesta es la misma (404) se escriba o no el registro.
    if (await shouldLogTenantDenied(userId)) {
      await logAuditEvent({
        action: "tenant.access_denied",
        result: "denied",
        actorUserId: userId,
        resourceType: "tenant",
        resourceId: isUuid(requestedTenantId) ? requestedTenantId : undefined,
        details: { reason: canonical ? "not_a_member" : "invalid_id" },
      });
    }
    return null;
  }

  const context = await getRequestContext();
  const supabase = await createClient({
    [TENANT_HEADER]: membership.tenantId,
    [REQUEST_ID_HEADER]: context.requestId,
    ...(context.clientIp ? { [CLIENT_IP_HEADER]: context.clientIp } : {}),
  });

  return {
    tenantId: membership.tenantId,
    tenantName: membership.name,
    role: membership.role,
    userId,
    supabase,
  };
}

const resolveForCurrentUser = cache(
  async (requestedTenantId: string): Promise<ActiveTenant | null> => {
    const user = await requireUser();
    const resolved = await resolveActiveTenant({ userId: user.id, requestedTenantId });
    return resolved ? { ...resolved, user } : null;
  },
);

/** Para pantallas y acciones: la organización activa o "No encontrado" (404 idéntico en todos los casos). */
export async function requireActiveTenant(requestedTenantId: string): Promise<ActiveTenant> {
  const active = await resolveForCurrentUser(requestedTenantId);
  if (!active) notFound();
  return active;
}

/**
 * La última organización que usó la persona, solo para "volver a donde estaba". No tiene valor de
 * seguridad: el destino igual pasa por `requireActiveTenant`. Se lee con la función de la base de
 * datos `my_last_tenant_id` (solo entrega la propia, y solo si sigue siendo miembro), nunca con un
 * `select` a `profiles`: la columna `last_tenant_id` no es legible por tabla (H-012, migración 12).
 */
export async function getLastTenantId(): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_last_tenant_id");
  if (error || typeof data !== "string") return null;
  return data;
}

/**
 * A qué organización enviar a quien acaba de entrar: la última que usó si sigue siendo suya, o la
 * primera de su lista. `null` si todavía no tiene ninguna.
 */
export async function resolveLandingTenant(user: SessionUser): Promise<string | null> {
  const memberships = await listMemberships(user.id);
  if (memberships.length === 0) return null;
  const lastTenantId = await getLastTenantId();
  const last = memberships.find((m) => m.tenantId === lastTenantId);
  return (last ?? memberships[0]).tenantId;
}

/** Recuerda la organización elegida para la próxima vez que la persona entre. */
export async function rememberLastTenant(active: ActiveTenant): Promise<void> {
  await active.supabase
    .from("profiles")
    .update({ last_tenant_id: active.tenantId })
    .eq("user_id", active.userId);
}
