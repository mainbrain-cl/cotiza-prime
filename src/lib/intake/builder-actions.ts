"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/lib/auth/form-state";
import { getAppOrigin } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { requireActiveTenant, type ActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import {
  embedSnippetFor,
  publicFormUrl,
  toSavePayload,
  type EditorForm,
  type FormStatus,
} from "./builder-model";
import { MAX_EMBED_ORIGINS, embedOriginProblem } from "./embed";
import { parseDailyCap } from "./protection-model";
import { GENERIC_FAILURE, NO_PERMISSION, mapBuilderError } from "./builder-errors";
import { itemsToKeepInactive } from "./builder-queries";
import { editorFormSchema, isFormId, validateEditorForm } from "./builder-schema";

/** Resultado de las acciones del editor. Nunca lleva detalle técnico. */
export type BuilderResult =
  | {
      status: "ok";
      message: string;
      revision?: number;
      formStatus?: FormStatus;
      /** Enlace público, solo si el formulario está publicado o en pausa. */
      publicUrl?: string | null;
      /** Código para pegar en el sitio web (H-093), solo si está publicado o en pausa. */
      embedSnippet?: string | null;
      /** Sitios autorizados tal como quedaron guardados (H-093). */
      embedOrigins?: string[];
      /** Tope diario de solicitudes tal como quedó guardado (H-092). */
      dailyCap?: number;
    }
  | {
      status: "error";
      message: string;
      kind: "conflict" | "forbidden" | "not_found" | "other" | "invalid";
      fieldErrors?: Record<string, string>;
      fixHref?: string;
      fixLabel?: string;
    };

const NOT_FOUND_MESSAGE = "No encontramos este formulario. Puede que ya no exista.";
const ID_INVALID = { status: "error", kind: "not_found", message: NOT_FOUND_MESSAGE } as const;

function canManageForms(role: string): boolean {
  return role === "owner" || role === "admin";
}

const FORBIDDEN = { status: "error", kind: "forbidden", message: NO_PERMISSION } as const;

function failure(
  active: ActiveTenant,
  error: { code?: string | null; message?: string | null },
  logName: string,
  context: "save" | "other" = "other",
): BuilderResult {
  const mapped = mapBuilderError(error, context);
  const base = {
    status: "error" as const,
    kind: mapped.kind,
    message: mapped.message,
  };
  if (mapped.kind === "other" && mapped.message === GENERIC_FAILURE) {
    // Solo el código: nunca el mensaje de la base ni datos de la persona.
    void serverLog("error", logName, { code: error.code ?? "unknown" });
  }
  if (mapped.fixPath) {
    return {
      ...base,
      fixHref: tenantPath(active.tenantId, mapped.fixPath),
      fixLabel: mapped.fixLabel,
    };
  }
  return base;
}

function refresh(active: ActiveTenant) {
  revalidatePath(tenantPath(active.tenantId, "formularios"), "layout");
}

/** El enlace público de un formulario publicado o en pausa; `null` en los demás estados. */
async function readPublicUrl(
  active: ActiveTenant,
  formId: string,
): Promise<{
  status: FormStatus;
  publicUrl: string | null;
  embedSnippet: string | null;
} | null> {
  const { data } = await active.supabase
    .from("intake_forms")
    .select("public_id, status")
    .eq("id", formId)
    .maybeSingle();
  if (!data) return null;
  const status = data.status as FormStatus;
  const live = status === "published" || status === "paused";
  return {
    status,
    publicUrl: live ? publicFormUrl(getAppOrigin(), data.public_id as string) : null,
    embedSnippet: live ? embedSnippetFor(getAppOrigin(), data.public_id as string) : null,
  };
}

/** H-086: crea un formulario en borrador y lleva al editor. El id viene de la pantalla: un doble clic no crea dos. */
export async function createIntakeFormAction(
  tenantId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const active = await requireActiveTenant(tenantId);
  const rawName = formData.get("name");
  const rawId = formData.get("formId");
  const name = typeof rawName === "string" ? rawName : "";
  if (!canManageForms(active.role)) {
    return { status: "error", message: NO_PERMISSION, values: { name } };
  }
  const parsed = editorFormSchema.shape.name.safeParse(name);
  if (!parsed.success) {
    return {
      status: "error",
      fieldErrors: { name: parsed.error.issues[0]?.message ?? "Escribe un nombre interno." },
      values: { name },
    };
  }
  if (!isFormId(rawId)) {
    return { status: "error", message: GENERIC_FAILURE, values: { name } };
  }
  const { error } = await active.supabase.rpc("create_intake_form", {
    p_form_id: rawId,
    p_name: parsed.data,
  });
  if (error) {
    const result = failure(active, error, "intake_form_create_failed");
    return { status: "error", message: result.message, values: { name } };
  }
  refresh(active);
  redirect(tenantPath(active.tenantId, `formularios/${rawId}`));
}

/** H-086: guarda el editor. Si otra pestaña guardó antes, avisa y no pierde lo escrito (CP409). */
export async function saveIntakeFormAction(
  tenantId: string,
  formId: string,
  expectedRevision: number,
  input: EditorForm,
): Promise<BuilderResult> {
  const active = await requireActiveTenant(tenantId);
  if (!canManageForms(active.role)) return FORBIDDEN;
  if (!isFormId(formId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return ID_INVALID;
  }
  const validated = validateEditorForm(input);
  if (!validated.ok) {
    return {
      status: "error",
      kind: "invalid",
      message: "Revisa los campos marcados y vuelve a guardar.",
      fieldErrors: validated.errors,
    };
  }
  const payload = toSavePayload(validated.data as EditorForm);
  // En un formulario publicado, un servicio quitado que ya tuvo solicitudes se guarda inactivo, no se borra.
  const current = await readPublicUrl(active, formId);
  if (current && (current.status === "published" || current.status === "paused")) {
    const keep = await itemsToKeepInactive(
      active,
      formId,
      payload.items.map((item) => item.id as string),
    );
    if (!keep) return { status: "error", kind: "other", message: GENERIC_FAILURE };
    payload.items.push(...keep);
  }
  const { data, error } = await active.supabase.rpc("save_intake_form", {
    p_form_id: formId,
    p_expected_revision: expectedRevision,
    p_form: payload.form,
    p_items: payload.items,
  });
  if (error) return failure(active, error, "intake_form_save_failed", "save");
  const revision = (data as { revision?: number } | null)?.revision;
  if (typeof revision !== "number") {
    await serverLog("error", "intake_form_save_bad_response");
    return { status: "error", kind: "other", message: GENERIC_FAILURE };
  }
  refresh(active);
  return { status: "ok", message: "Guardamos los cambios del formulario.", revision };
}

const STATUS_MESSAGES: Record<"published" | "paused" | "archived", string> = {
  published: "Publicamos el formulario.",
  paused: "Pausamos el formulario: quien abra el enlace verá que por ahora no recibe solicitudes.",
  archived: "Archivamos el formulario.",
};

/** H-086: publicar, pausar, reanudar (publicar de nuevo) o archivar. */
export async function setIntakeFormStatusAction(
  tenantId: string,
  formId: string,
  status: "published" | "paused" | "archived",
  resumed = false,
): Promise<BuilderResult> {
  const active = await requireActiveTenant(tenantId);
  if (!canManageForms(active.role)) return FORBIDDEN;
  if (!isFormId(formId) || !["published", "paused", "archived"].includes(status)) {
    return ID_INVALID;
  }
  const { error } = await active.supabase.rpc("set_intake_form_status", {
    p_form_id: formId,
    p_status: status,
  });
  if (error) return failure(active, error, "intake_form_status_failed");
  refresh(active);
  const read = await readPublicUrl(active, formId);
  return {
    status: "ok",
    message: resumed ? "Reanudamos el formulario." : STATUS_MESSAGES[status],
    formStatus: read?.status ?? status,
    publicUrl: read?.publicUrl ?? null,
    embedSnippet: read?.embedSnippet ?? null,
  };
}

/** H-086: crea otra dirección pública. La anterior (y los códigos QR impresos) dejan de servir. */
export async function regenerateIntakeFormLinkAction(
  tenantId: string,
  formId: string,
): Promise<BuilderResult> {
  const active = await requireActiveTenant(tenantId);
  if (!canManageForms(active.role)) return FORBIDDEN;
  if (!isFormId(formId)) return ID_INVALID;
  const { error } = await active.supabase.rpc("regenerate_intake_form_public_id", {
    p_form_id: formId,
  });
  if (error) return failure(active, error, "intake_form_regenerate_failed");
  refresh(active);
  const read = await readPublicUrl(active, formId);
  return {
    status: "ok",
    message: "Creamos un enlace nuevo. El anterior dejó de funcionar.",
    formStatus: read?.status,
    publicUrl: read?.publicUrl ?? null,
    embedSnippet: read?.embedSnippet ?? null,
  };
}

/**
 * H-093: guarda los sitios autorizados para incrustar el formulario. Solo Dueño y Administrador. Cada sitio se
 * valida aquí con la misma regla del navegador (`isValidEmbedOrigin`) y otra vez en la base, que además deja el
 * cambio en la auditoría (`intake_form.embed_origins_changed`, con la lista anterior y la nueva). No toca el
 * resto del formulario ni su revisión: se manda a `save_intake_form` SOLO esa clave y sin servicios.
 */
export async function saveEmbedOriginsAction(
  tenantId: string,
  formId: string,
  origins: readonly string[],
): Promise<BuilderResult> {
  const active = await requireActiveTenant(tenantId);
  if (!canManageForms(active.role)) return FORBIDDEN;
  if (!isFormId(formId)) return ID_INVALID;
  if (!Array.isArray(origins) || origins.some((origin) => typeof origin !== "string")) {
    return { status: "error", kind: "invalid", message: GENERIC_FAILURE };
  }
  const unique = [...new Set(origins)].sort();
  if (unique.length > MAX_EMBED_ORIGINS) {
    return {
      status: "error",
      kind: "invalid",
      message: `Puedes autorizar hasta ${MAX_EMBED_ORIGINS} sitios.`,
    };
  }
  const problem = unique.map(embedOriginProblem).find((text) => text !== null);
  if (problem) return { status: "error", kind: "invalid", message: problem };
  // La revisión vigente: este cambio no la mueve, pero la función la pide para detectar cambios cruzados.
  const { data: row } = await active.supabase
    .from("intake_forms")
    .select("revision")
    .eq("id", formId)
    .maybeSingle();
  if (!row) return ID_INVALID;
  const { error } = await active.supabase.rpc("save_intake_form", {
    p_form_id: formId,
    p_expected_revision: row.revision as number,
    p_form: { embed_origins: unique },
    p_items: null,
  });
  if (error) return failure(active, error, "intake_form_embed_origins_failed", "save");
  refresh(active);
  return {
    status: "ok",
    message:
      unique.length === 0
        ? "Quitamos todos los sitios autorizados."
        : "Guardamos los sitios autorizados.",
    embedOrigins: unique,
  };
}

/**
 * H-092: cambia el tope diario de solicitudes del formulario (1 a 200). Solo Dueño y Administrador. Se valida
 * aquí y otra vez en la base (`invalid_daily_cap`). Se manda a `save_intake_form` SOLO esa clave y sin servicios:
 * la base no sube la revisión del formulario por un cambio interno (así no choca con quien esté editando).
 * El tope de la organización (300 al día) no se toca desde aquí.
 */
export async function saveDailyCapAction(
  tenantId: string,
  formId: string,
  dailyCap: number,
): Promise<BuilderResult> {
  const active = await requireActiveTenant(tenantId);
  if (!canManageForms(active.role)) return FORBIDDEN;
  if (!isFormId(formId)) return ID_INVALID;
  // Desde el navegador llega un número: un texto ("50") no se acepta.
  const parsed = parseDailyCap(typeof dailyCap === "number" ? dailyCap : null);
  if (!parsed.ok) return { status: "error", kind: "invalid", message: parsed.message };
  const { data: row, error: readError } = await active.supabase
    .from("intake_forms")
    .select("revision")
    .eq("id", formId)
    .maybeSingle();
  // Una falla de la base no es «no existe»: se dice que no se pudo, no que el formulario se perdió.
  if (readError) return failure(active, readError, "intake_form_daily_cap_read_failed");
  if (!row) return ID_INVALID;
  const { error } = await active.supabase.rpc("save_intake_form", {
    p_form_id: formId,
    p_expected_revision: row.revision as number,
    p_form: { daily_cap: parsed.value },
    p_items: null,
  });
  if (error) return failure(active, error, "intake_form_daily_cap_failed", "save");
  refresh(active);
  return {
    status: "ok",
    message: `Guardamos el tope: ${parsed.value} ${parsed.value === 1 ? "solicitud" : "solicitudes"} por día.`,
    dailyCap: parsed.value,
  };
}
