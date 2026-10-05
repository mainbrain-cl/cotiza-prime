"use server";

import { revalidatePath } from "next/cache";
import { fieldErrorsOf } from "@/lib/auth/schemas";
import { serverLog } from "@/lib/log/server-log";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import type { BrandSaveState } from "./form-state";
import { inspectLogo, LOGO_MAX_BYTES, LOGO_TOO_BIG_MESSAGE, newLogoPath } from "./logo";
import { brandColorsSchema } from "./schemas";
import { loadBrand, LOGO_BUCKET } from "./service";

const NOT_ALLOWED_MESSAGE = "Solo el Dueño o un Administrador puede cambiar la marca.";
const SAVE_FAILED_MESSAGE = "No pudimos guardar la marca. Intenta de nuevo en unos minutos.";

function readText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * H-007: guarda los colores y, si se eligió uno, el logo (o lo quita). Solo Dueño y Administrador;
 * la base de datos y Storage lo vuelven a verificar con sus propias políticas.
 */
export async function saveBrandAction(
  tenantId: string,
  _previous: BrandSaveState,
  formData: FormData,
): Promise<BrandSaveState> {
  const active = await requireActiveTenant(tenantId);
  const values = {
    primaryColor: readText(formData, "primaryColor"),
    secondaryColor: readText(formData, "secondaryColor"),
  };

  if (active.role !== "owner" && active.role !== "admin") {
    return { status: "error", message: NOT_ALLOWED_MESSAGE, values };
  }

  const parsed = brandColorsSchema.safeParse(values);
  if (!parsed.success) {
    return { status: "error", fieldErrors: fieldErrorsOf(parsed.error), values };
  }

  const removeLogo = readText(formData, "removeLogo") === "1";
  const file = formData.get("logo");
  const hasFile = file instanceof File && file.size > 0;

  // 1. Revisar el archivo antes de tocar nada: el tamaño primero, para no leer lo que sobra.
  let upload: { path: string; bytes: Uint8Array; mime: string } | null = null;
  if (hasFile) {
    if (file.size > LOGO_MAX_BYTES) {
      return { status: "error", fieldErrors: { logo: LOGO_TOO_BIG_MESSAGE }, values };
    }
    const check = inspectLogo(new Uint8Array(await file.arrayBuffer()));
    if (!check.ok) {
      return { status: "error", fieldErrors: { logo: check.message }, values };
    }
    upload = {
      path: newLogoPath(active.tenantId, check.ext),
      bytes: check.bytes,
      mime: check.mime,
    };
  }

  const current = await loadBrand(active);
  if (!current) {
    await serverLog("error", "brand_load_failed");
    return { status: "error", message: SAVE_FAILED_MESSAGE, values };
  }

  // 2. Subir el logo nuevo con el cliente de la organización: Storage aplica sus políticas.
  const storage = active.supabase.storage.from(LOGO_BUCKET);
  if (upload) {
    const { error } = await storage.upload(upload.path, upload.bytes, {
      contentType: upload.mime,
      upsert: false,
    });
    if (error) {
      await serverLog("error", "logo_upload_failed", { tenantId: active.tenantId });
      return {
        status: "error",
        message: "No pudimos subir el logo. Intenta de nuevo en unos minutos.",
        values,
      };
    }
  }

  // 3. Guardar colores y ruta del logo.
  const logoPath = upload ? upload.path : removeLogo ? null : current.logoPath;
  const { data: updated, error: updateError } = await active.supabase
    .from("tenants")
    .update({
      brand_primary_color: parsed.data.primaryColor,
      brand_secondary_color: parsed.data.secondaryColor,
      logo_path: logoPath,
    })
    .eq("tenant_id", active.tenantId)
    .select("tenant_id");

  if (updateError || !updated || updated.length === 0) {
    if (upload) await storage.remove([upload.path]); // no dejar un archivo huérfano
    await serverLog("error", "brand_update_failed", { code: updateError?.code });
    return { status: "error", message: SAVE_FAILED_MESSAGE, values };
  }

  // 4. Borrar el logo anterior (si falla, queda un archivo suelto, nunca un logo roto).
  if (current.logoPath && current.logoPath !== logoPath) {
    const { error } = await storage.remove([current.logoPath]);
    if (error) await serverLog("warn", "old_logo_cleanup_failed", { tenantId: active.tenantId });
  }

  revalidatePath(tenantPath(active.tenantId), "layout");
  return {
    status: "saved",
    values: { primaryColor: parsed.data.primaryColor, secondaryColor: parsed.data.secondaryColor },
  };
}
