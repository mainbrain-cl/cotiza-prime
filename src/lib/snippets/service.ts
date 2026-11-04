import "server-only";
import { z } from "zod";
import { serverLog } from "@/lib/log/server-log";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import {
  SNIPPET_GENERIC_FAILURE,
  SNIPPET_NOT_FOUND,
  mapSnippetError,
  type SnippetError,
  type SnippetField,
} from "./errors";
import { isSnippetKind } from "./model";
import { checkKindRules, type CreateSnippetInput, type UpdateSnippetInput } from "./schemas";

/**
 * Crear, cambiar y borrar textos guardados (H-048a). Corre con el pase de la persona (nunca con la llave
 * maestra); la base vuelve a revisar el permiso, las reglas del texto y el tope en cada función. Quien llama
 * (`actions.ts`) ya comprobó que es miembro y que su rol alcanza ANTES de llegar aquí.
 *
 * Nada de lo que escribe la persona (nombre, texto) llega a un log: solo códigos.
 */

export type SnippetActionResult =
  | {
      status: "ok";
      outcome: "created" | "exists" | "updated" | "unchanged" | "deleted";
      message: string;
      id?: string;
      revision?: number;
    }
  | {
      status: "error";
      kind: SnippetError["kind"];
      message: string;
      fieldErrors?: Partial<Record<SnippetField, string>>;
    };

const savedSchema = z.object({
  result: z.enum(["created", "exists", "updated", "unchanged"]),
  id: z.uuid(),
  revision: z.number().int().min(1),
});
const deletedSchema = z.object({ result: z.literal("deleted") });

const CREATED_MESSAGE = "Guardamos el texto.";
const EXISTS_MESSAGE = "Este texto ya estaba guardado; revisa que quedó como querías.";
const UPDATED_MESSAGE = "Guardamos los cambios.";
const UNCHANGED_MESSAGE = "No hay cambios que guardar.";
const DELETED_MESSAGE = "Eliminamos el texto.";

function failure(
  error: { code?: string | null; message?: string | null },
  logName: string,
): SnippetActionResult {
  const mapped = mapSnippetError(error);
  if (mapped.kind === "other") {
    // Solo el código: nunca el mensaje de la base ni lo que escribió la persona.
    void serverLog("error", logName, { code: error.code ?? "unknown" });
  }
  return {
    status: "error",
    kind: mapped.kind,
    message: mapped.message,
    ...(mapped.field ? { fieldErrors: { [mapped.field]: mapped.message } } : {}),
  };
}

function badShape(logName: string): SnippetActionResult {
  void serverLog("error", logName, { code: "shape" });
  return { status: "error", kind: "other", message: SNIPPET_GENERIC_FAILURE };
}

export async function createSnippet(
  active: ActiveTenant,
  input: CreateSnippetInput,
): Promise<SnippetActionResult> {
  const { data, error } = await active.supabase.rpc("create_text_snippet", {
    p_snippet_id: input.id,
    p_kind: input.kind,
    p_name: input.name,
    p_body: input.body,
    p_is_default: input.isDefault,
  });
  if (error) return failure(error, "snippet_create_failed");
  const parsed = savedSchema.safeParse(data);
  if (!parsed.success) return badShape("snippet_create_failed");
  // `exists`: el mismo identificador otra vez (doble clic o se perdió la respuesta y la persona reintentó,
  // quizá con otro nombre). El texto ya está guardado: es un éxito, pero no decimos que lo guardamos ahora,
  // porque lo guardado puede no ser lo que acaba de escribir.
  const exists = parsed.data.result === "exists";
  return {
    status: "ok",
    outcome: exists ? "exists" : "created",
    message: exists ? EXISTS_MESSAGE : CREATED_MESSAGE,
    id: parsed.data.id,
    revision: parsed.data.revision,
  };
}

export async function updateSnippet(
  active: ActiveTenant,
  input: UpdateSnippetInput,
): Promise<SnippetActionResult> {
  // El tipo es el que ya tiene guardado el texto, nunca uno que mande el navegador (el tipo no cambia).
  const { data: stored, error: readError } = await active.supabase
    .from("text_snippets")
    .select("kind")
    .eq("tenant_id", active.tenantId)
    .eq("id", input.id)
    .maybeSingle();
  if (readError) return failure(readError, "snippet_update_read_failed");
  if (!stored || !isSnippetKind(stored.kind)) {
    return { status: "error", kind: "not_found", message: SNIPPET_NOT_FOUND };
  }
  const problem = checkKindRules(stored.kind, { body: input.body, isDefault: input.isDefault });
  if (problem) {
    return {
      status: "error",
      kind: "invalid",
      message: problem.message,
      fieldErrors: { [problem.path]: problem.message },
    };
  }

  const { data, error } = await active.supabase.rpc("update_text_snippet", {
    p_snippet_id: input.id,
    p_expected_revision: input.expectedRevision,
    p_name: input.name,
    p_body: input.body,
    p_is_default: input.isDefault,
  });
  if (error) return failure(error, "snippet_update_failed");
  const parsed = savedSchema.safeParse(data);
  if (!parsed.success) return badShape("snippet_update_failed");
  return {
    status: "ok",
    outcome: parsed.data.result === "unchanged" ? "unchanged" : "updated",
    message: parsed.data.result === "unchanged" ? UNCHANGED_MESSAGE : UPDATED_MESSAGE,
    id: parsed.data.id,
    revision: parsed.data.revision,
  };
}

export async function deleteSnippet(
  active: ActiveTenant,
  snippetId: string,
): Promise<SnippetActionResult> {
  const { data, error } = await active.supabase.rpc("delete_text_snippet", {
    p_snippet_id: snippetId,
  });
  if (error) {
    // Un texto que ya no existe se trata como éxito: el resultado que se quería ya está.
    if (error.code === "CP404" && error.message === "snippet_not_found") {
      return { status: "ok", outcome: "deleted", message: DELETED_MESSAGE };
    }
    return failure(error, "snippet_delete_failed");
  }
  if (!deletedSchema.safeParse(data).success) return badShape("snippet_delete_failed");
  return { status: "ok", outcome: "deleted", message: DELETED_MESSAGE };
}
