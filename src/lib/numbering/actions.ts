"use server";

import { fieldErrorsOf } from "@/lib/auth/schemas";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tooLowMessage } from "./format";
import type { NumberingSaveState } from "./form-state";
import { numberingSchema } from "./schemas";
import { loadNumberingState, minimumFor, previewFor } from "./service";

const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";
const SQLSTATE_CHECK_VIOLATION = "23514";

export type NumberingPreview =
  | { ok: true; preview: string; minimum: number }
  | { ok: false; fieldErrors: Record<string, string>; minimum?: number };

function readText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** Vista previa en vivo: la calcula el servidor con la configuración y los contadores reales. */
export async function previewNumberingAction(
  tenantId: string,
  raw: { prefix: string; mode: string; startNumber: string },
): Promise<NumberingPreview> {
  const active = await requireActiveTenant(tenantId);
  const parsed = numberingSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsOf(parsed.error) };

  const state = await loadNumberingState(active);
  if (!state) return { ok: false, fieldErrors: { _form: "No pudimos calcular el ejemplo." } };

  const minimum = minimumFor(state, parsed.data.mode);
  if (parsed.data.startNumber < minimum) {
    return { ok: false, minimum, fieldErrors: { startNumber: tooLowMessage(minimum) } };
  }
  return {
    ok: true,
    minimum,
    preview: previewFor(state, {
      prefix: parsed.data.prefix,
      mode: parsed.data.mode,
      sequence: parsed.data.startNumber,
    }),
  };
}

/** H-024: guarda la numeración. La base de datos vuelve a verificar rol y que el número nunca retroceda. */
export async function saveNumberingAction(
  tenantId: string,
  _previous: NumberingSaveState,
  formData: FormData,
): Promise<NumberingSaveState> {
  const active = await requireActiveTenant(tenantId);
  const raw = {
    prefix: readText(formData, "prefix"),
    mode: readText(formData, "mode"),
    startNumber: readText(formData, "startNumber"),
  };

  if (active.role !== "owner" && active.role !== "admin") {
    return {
      status: "error",
      message: "Solo el Dueño o un Administrador puede cambiar la numeración.",
      values: raw,
    };
  }

  const parsed = numberingSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  }

  const state = await loadNumberingState(active);
  if (state) {
    const minimum = minimumFor(state, parsed.data.mode);
    if (parsed.data.startNumber < minimum) {
      return {
        status: "error",
        fieldErrors: { startNumber: tooLowMessage(minimum) },
        values: raw,
      };
    }
  }

  const { data, error } = await active.supabase.rpc("set_numbering", {
    p_prefix: parsed.data.prefix,
    p_mode: parsed.data.mode,
    p_start_number: parsed.data.startNumber,
  });

  if (error || typeof data !== "string") {
    if (error?.code === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
      return {
        status: "error",
        message: "Solo el Dueño o un Administrador puede cambiar la numeración.",
        values: raw,
      };
    }
    if (error?.code === SQLSTATE_CHECK_VIOLATION) {
      // Alguien más pudo haber creado una cotización entre la vista previa y el guardado.
      const minimum = /(\d+)\s*$/.exec(error.message ?? "")?.[1];
      return {
        status: "error",
        fieldErrors: {
          startNumber: minimum
            ? tooLowMessage(Number(minimum))
            : "El número de partida es menor que el último usado.",
        },
        values: raw,
      };
    }
    console.error(
      JSON.stringify({ level: "error", message: "set_numbering_failed", code: error?.code }),
    );
    return {
      status: "error",
      message: "No pudimos guardar la numeración. Intenta de nuevo en unos minutos.",
      values: raw,
    };
  }

  return { status: "saved", savedPreview: data, values: raw };
}
