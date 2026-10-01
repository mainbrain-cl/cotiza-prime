"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/lib/auth/form-state";
import { fieldErrorsOf } from "@/lib/auth/schemas";
import { requireUser } from "@/lib/auth/session";
import { serverLog } from "@/lib/log/server-log";
import { createClient } from "@/lib/supabase/server";
import { rememberLastTenant, requireActiveTenant } from "./active-tenant";
import { tenantPath } from "./constants";
import { createTenantSchema } from "./schemas";

function readText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";
const SQLSTATE_INVALID_PARAMETER = "22023";
const SQLSTATE_CONFIGURATION_LIMIT = "53400";

/** H-005: crea la organización (quien la crea queda como Dueño). Valida en el servidor; el navegador solo avisa antes. */
export async function createTenantAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireUser();

  const raw = {
    name: readText(formData, "name"),
    rut: readText(formData, "rut"),
    industry: readText(formData, "industry"),
    contactEmail: readText(formData, "contactEmail"),
    contactPhone: readText(formData, "contactPhone"),
  };
  const parsed = createTenantSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values: raw };
  }

  // El RPC no recibe un tenant_id: la base lo genera y da la membresía de Dueño al usuario de la sesión.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_tenant", {
    p_name: parsed.data.name,
    p_rut: parsed.data.rut,
    p_industry: parsed.data.industry,
    p_contact_email: parsed.data.contactEmail,
    p_contact_phone: parsed.data.contactPhone,
  });

  if (error || typeof data !== "string") {
    if (error?.code === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
      return {
        status: "error",
        message: "Verifica tu correo antes de crear una organización.",
        values: raw,
      };
    }
    if (error?.code === SQLSTATE_INVALID_PARAMETER) {
      return {
        status: "error",
        fieldErrors: { rut: "El RUT no es válido. Revisa el número y el dígito verificador." },
        values: raw,
      };
    }
    if (error?.code === SQLSTATE_CONFIGURATION_LIMIT) {
      return {
        status: "error",
        message: "Llegaste al máximo de organizaciones que puedes crear con una cuenta.",
        values: raw,
      };
    }
    await serverLog("error", "create_tenant_failed", { code: error?.code });
    return {
      status: "error",
      message: "No pudimos crear la organización. Intenta de nuevo en unos minutos.",
      values: raw,
    };
  }

  redirect(tenantPath(data));
}

/** H-006: cambiar de organización. Verifica la membresía y recuerda la elección para el próximo ingreso. */
export async function switchTenantAction(tenantId: string): Promise<void> {
  const active = await requireActiveTenant(tenantId);
  await rememberLastTenant(active);
  redirect(tenantPath(active.tenantId));
}
