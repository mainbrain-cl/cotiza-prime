"use server";

import { revalidatePath } from "next/cache";
import { fieldErrorsOf } from "@/lib/auth/schemas";
import { serverLog } from "@/lib/log/server-log";
import { requirePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import type { BrandSaveState } from "./form-state";
import { inspectLogo, LOGO_MAX_BYTES, LOGO_TOO_BIG_MESSAGE, newLogoPath } from "./logo";
import { removeUploadedLogo, uploadCleanedLogo } from "./logo-storage";
import { brandColorsSchema } from "./schemas";
import { loadBrand, LOGO_BUCKET } from "./service";

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

  const denied = requirePermission(active, "settings.manage");
  if (denied) return { status: "error", message: denied, values };

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

  // 2. Subir el logo ya limpiado. La sesión de la persona no puede escribir en el bucket
  //    (migración 19): sube el servidor, y solo lo que acaba de pasar por `inspectLogo`.
  if (upload) {
    const uploaded = await uploadCleanedLogo(upload.path, upload.bytes, upload.mime);
    if (!uploaded.ok) {
      await serverLog("error", "logo_upload_failed", { tenantId: active.tenantId });
      return {
        status: "error",
        message: "No pudimos subir el logo. Intenta de nuevo en unos minutos.",
        values,
      };
    }
  }

  // 3. Guardar colores y ruta del logo, juntos, con la función de base de datos (vuelve a
  //    verificar rol y que el archivo exista en la carpeta de la organización).
  const logoPath = upload ? upload.path : removeLogo ? null : current.logoPath;
  const { error: saveError } = await active.supabase.rpc("save_tenant_brand", {
    p_primary_color: parsed.data.primaryColor,
    p_secondary_color: parsed.data.secondaryColor,
    p_logo_mode: upload ? "set" : removeLogo ? "remove" : "keep",
    p_logo_path: upload ? upload.path : null,
  });

  if (saveError) {
    if (upload) await removeUploadedLogo(upload.path); // no dejar un archivo huérfano
    await serverLog("error", "brand_update_failed", { code: saveError.code });
    return { status: "error", message: SAVE_FAILED_MESSAGE, values };
  }

  // 4. Borrar el logo anterior (si falla, queda un archivo suelto, nunca un logo roto).
  if (current.logoPath && current.logoPath !== logoPath) {
    const { error } = await active.supabase.storage.from(LOGO_BUCKET).remove([current.logoPath]);
    if (error) await serverLog("warn", "old_logo_cleanup_failed", { tenantId: active.tenantId });
  }

  revalidatePath(tenantPath(active.tenantId), "layout");
  return {
    status: "saved",
    values: { primaryColor: parsed.data.primaryColor, secondaryColor: parsed.data.secondaryColor },
  };
}
