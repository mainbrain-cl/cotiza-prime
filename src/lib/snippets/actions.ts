"use server";

import { revalidatePath } from "next/cache";
import { fieldErrorsOf } from "@/lib/auth/schemas";
import { requirePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { SNIPPET_NOT_FOUND } from "./errors";
import { createSnippetSchema, deleteSnippetSchema, updateSnippetSchema } from "./schemas";
import { createSnippet, deleteSnippet, updateSnippet, type SnippetActionResult } from "./service";

/**
 * Acciones de «Textos listos» (H-048a). Cada una resuelve la organización activa, exige `settings.manage` con
 * la matriz ANTES de tocar la base (si no lo tiene, la base ni se consulta) y recién entonces valida y
 * ejecuta. La base vuelve a exigir el permiso en cada función (42501). Reciben datos simples (no un
 * formulario) para que la pantalla conserve lo escrito si algo falla. Nada de lo que escribe la persona
 * llega a un log.
 */

export type { SnippetActionResult };

const LIST_PATH = "configuracion/textos";

function refresh(tenantId: string, snippetId?: string) {
  revalidatePath(tenantPath(tenantId, LIST_PATH));
  if (snippetId) revalidatePath(tenantPath(tenantId, `${LIST_PATH}/${snippetId}`));
}

/** Crea un texto guardado. El identificador lo trae la pantalla: repetirlo (doble clic) no duplica nada. */
export async function createSnippetAction(
  tenantId: string,
  input: unknown,
): Promise<SnippetActionResult> {
  const active = await requireActiveTenant(tenantId);
  const denied = requirePermission(active, "settings.manage");
  if (denied) return { status: "error", kind: "forbidden", message: denied };

  const parsed = createSnippetSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = fieldErrorsOf(parsed.error);
    return {
      status: "error",
      kind: "invalid",
      message: Object.values(fieldErrors)[0] ?? "Revisa los datos del texto.",
      fieldErrors,
    };
  }
  const result = await createSnippet(active, parsed.data);
  if (result.status === "ok") refresh(active.tenantId, parsed.data.id);
  return result;
}

/** Cambia nombre, texto y «texto inicial». Si otra persona guardó antes, avisa y no pisa su cambio. */
export async function updateSnippetAction(
  tenantId: string,
  input: unknown,
): Promise<SnippetActionResult> {
  const active = await requireActiveTenant(tenantId);
  const denied = requirePermission(active, "settings.manage");
  if (denied) return { status: "error", kind: "forbidden", message: denied };

  const parsed = updateSnippetSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = fieldErrorsOf(parsed.error);
    return {
      status: "error",
      kind: "invalid",
      message: Object.values(fieldErrors)[0] ?? "Revisa los datos del texto.",
      fieldErrors,
    };
  }
  const result = await updateSnippet(active, parsed.data);
  if (result.status === "ok") refresh(active.tenantId, parsed.data.id);
  return result;
}

/** Elimina un texto guardado (de verdad). Las cotizaciones ya creadas no cambian: guardan su propia copia. */
export async function deleteSnippetAction(
  tenantId: string,
  snippetId: string,
): Promise<SnippetActionResult> {
  const active = await requireActiveTenant(tenantId);
  const denied = requirePermission(active, "settings.manage");
  if (denied) return { status: "error", kind: "forbidden", message: denied };

  if (!deleteSnippetSchema.safeParse({ id: snippetId }).success) {
    return { status: "error", kind: "not_found", message: SNIPPET_NOT_FOUND };
  }
  const result = await deleteSnippet(active, snippetId);
  if (result.status === "ok") refresh(active.tenantId, snippetId);
  return result;
}
