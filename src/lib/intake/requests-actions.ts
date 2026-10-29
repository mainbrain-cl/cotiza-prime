"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { serverLog } from "@/lib/log/server-log";
import { requirePermission } from "@/lib/permissions/require";
import { requireActiveTenant, type ActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid, tenantPath } from "@/lib/tenant/constants";
import { notifyRequestAssigned } from "./assignment-notice";
import {
  REQUEST_GENERIC_FAILURE,
  REQUEST_NOT_FOUND,
  mapRequestError,
  type RequestAction,
  type RequestErrorKind,
} from "./requests-errors";
import { DISCARD_NOTE_MAX, isAnonymizeReason, isDiscardReason } from "./requests-model";

/**
 * Acciones del equipo sobre una solicitud (H-089). El permiso por rol se revisa aquí con
 * `requirePermission` (matriz única, H-011a) ANTES de tocar la base; la base lo vuelve a exigir en cada
 * función (42501), incluido el detalle «¿es suya?» del Comercial. Además se valida la forma de lo
 * recibido y se traduce el error. Nada de lo que escribió el visitante pasa por aquí ni se escribe en
 * el registro.
 */

export type RequestActionResult =
  { status: "ok"; message: string } | { status: "error"; kind: RequestErrorKind; message: string };

const NOT_FOUND = { status: "error", kind: "not_found", message: REQUEST_NOT_FOUND } as const;

function forbidden(message: string): RequestActionResult {
  return { status: "error", kind: "forbidden", message };
}

function failure(
  error: { code?: string | null; message?: string | null },
  action: RequestAction,
): RequestActionResult {
  const mapped = mapRequestError(error, action);
  if (mapped.kind === "other" && mapped.message === REQUEST_GENERIC_FAILURE) {
    // Solo el código: nunca el mensaje de la base ni datos de nadie.
    void serverLog("error", `intake_request_${action}_failed`, { code: error.code ?? "unknown" });
  }
  return { status: "error", kind: mapped.kind, message: mapped.message };
}

function refresh(active: ActiveTenant) {
  revalidatePath(tenantPath(active.tenantId, "solicitudes"), "layout");
  // La insignia del menú vive en el diseño de toda la organización.
  revalidatePath(tenantPath(active.tenantId), "layout");
}

/** Asigna (o reasigna) la solicitud a un miembro activo. Avisa a esa persona sin bloquear la acción. */
export async function assignRequestAction(
  tenantId: string,
  requestId: string,
  assigneeUserId: string,
): Promise<RequestActionResult> {
  const active = await requireActiveTenant(tenantId);
  const denied = requirePermission(active, "intake.requests.assign");
  if (denied) return forbidden(denied);
  if (!isUuid(requestId)) return NOT_FOUND;
  if (!isUuid(assigneeUserId)) {
    return { status: "error", kind: "invalid", message: "Elige a quién asignar la solicitud." };
  }
  // La base acepta asignar una solicitud ya anonimizada: aquí no se ofrece.
  const { data: current, error: readError } = await active.supabase
    .from("intake_requests")
    .select("anonymized_at")
    .eq("id", requestId)
    .maybeSingle();
  if (readError) return failure(readError, "assign");
  if (!current) return NOT_FOUND;
  if (current.anonymized_at !== null) {
    return {
      status: "error",
      kind: "state",
      message: "Los datos de esta solicitud fueron eliminados: ya no se puede asignar.",
    };
  }
  const { data, error } = await active.supabase.rpc("assign_intake_request", {
    p_request_id: requestId,
    p_assignee_user_id: assigneeUserId,
  });
  if (error) return failure(error, "assign");
  refresh(active);
  const changed = (data as { changed?: boolean } | null)?.changed === true;
  if (changed) after(() => notifyRequestAssigned(requestId));
  return {
    status: "ok",
    message: changed ? "Asignamos la solicitud y avisamos a la persona." : "Ya estaba asignada.",
  };
}

/** Descarta con un motivo de la lista y una nota breve opcional. */
export async function discardRequestAction(
  tenantId: string,
  requestId: string,
  reason: string,
  note: string,
): Promise<RequestActionResult> {
  const active = await requireActiveTenant(tenantId);
  // Revisión gruesa por rol: que la solicitud sea suya (Comercial) lo exige la base de datos.
  const denied = requirePermission(active, "intake.requests.discard");
  if (denied) return forbidden(denied);
  if (!isUuid(requestId)) return NOT_FOUND;
  if (!isDiscardReason(reason)) {
    return { status: "error", kind: "invalid", message: "Elige el motivo para descartarla." };
  }
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (trimmed.length > DISCARD_NOTE_MAX) {
    return {
      status: "error",
      kind: "invalid",
      message: `La nota admite hasta ${DISCARD_NOTE_MAX} caracteres.`,
    };
  }
  const { error } = await active.supabase.rpc("discard_intake_request", {
    p_request_id: requestId,
    p_reason: reason,
    p_note: trimmed === "" ? null : trimmed,
  });
  if (error) return failure(error, "discard");
  refresh(active);
  return { status: "ok", message: "Descartamos la solicitud." };
}

/** Devuelve una solicitud descartada a «sin asignar». */
export async function restoreRequestAction(
  tenantId: string,
  requestId: string,
): Promise<RequestActionResult> {
  const active = await requireActiveTenant(tenantId);
  const denied = requirePermission(active, "intake.requests.restore");
  if (denied) return forbidden(denied);
  if (!isUuid(requestId)) return NOT_FOUND;
  const { error } = await active.supabase.rpc("restore_intake_request", {
    p_request_id: requestId,
  });
  if (error) return failure(error, "restore");
  refresh(active);
  return { status: "ok", message: "Restauramos la solicitud: quedó sin asignar." };
}

/** Elimina los datos personales de la solicitud. No se puede deshacer. */
export async function anonymizeRequestAction(
  tenantId: string,
  requestId: string,
  reason: string,
): Promise<RequestActionResult> {
  const active = await requireActiveTenant(tenantId);
  const denied = requirePermission(active, "intake.requests.anonymize");
  if (denied) return forbidden(denied);
  if (!isUuid(requestId)) return NOT_FOUND;
  if (!isAnonymizeReason(reason)) {
    return {
      status: "error",
      kind: "invalid",
      message: "Elige el motivo para eliminar los datos.",
    };
  }
  const { error } = await active.supabase.rpc("anonymize_intake_request", {
    p_request_id: requestId,
    p_reason: reason,
  });
  if (error) return failure(error, "anonymize");
  refresh(active);
  return { status: "ok", message: "Eliminamos los datos de la solicitud." };
}
