"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/lib/auth/form-state";
import { getAppOrigin } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { requireActiveTenant, type ActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { publicFormUrl, toSavePayload, type EditorForm, type FormStatus } from "./builder-model";
import { GENERIC_FAILURE, NO_PERMISSION, mapBuilderError } from "./builder-errors";
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
): BuilderResult {
  const mapped = mapBuilderError(error);
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
): Promise<{ status: FormStatus; publicUrl: string | null } | null> {
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
  const { data, error } = await active.supabase.rpc("save_intake_form", {
    p_form_id: formId,
    p_expected_revision: expectedRevision,
    p_form: payload.form,
    p_items: payload.items,
  });
  if (error) return failure(active, error, "intake_form_save_failed");
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
  };
}
