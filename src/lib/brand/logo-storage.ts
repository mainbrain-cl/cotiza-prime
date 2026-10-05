import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";
import { LOGO_BUCKET } from "./service";

/**
 * Subida de logos a Storage (H-007).
 *
 * Es el ÚNICO lugar del módulo de marca que usa la llave maestra, y solo para escribir en el
 * bucket de logos: la sesión de la persona ya no puede insertar ahí (migración 19), para que nadie
 * se salte la limpieza del archivo (`inspectLogo` / `sanitizeSvg`). Quien llama debe haber
 * resuelto la organización con `requireActiveTenant`, verificado que sea Dueño o Administrador y
 * pasar bytes YA limpiados por `inspectLogo`; la ruta la arma `newLogoPath` con el tenant_id de la
 * organización activa. Esta función no decide nada por su cuenta: solo escribe donde se le dice.
 *
 * No toca datos de negocio: la ruta del logo se guarda después con la función de base de datos
 * `save_tenant_brand`, que vuelve a verificar rol y que el archivo exista en la carpeta de la
 * organización.
 */
export async function uploadCleanedLogo(
  path: string,
  bytes: Uint8Array,
  mime: string,
): Promise<{ ok: boolean }> {
  const { error } = await createAdminClient()
    .storage.from(LOGO_BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false });
  return { ok: !error };
}

/** Quita un archivo subido que quedó huérfano (si falla el guardado de la ruta). */
export async function removeUploadedLogo(path: string): Promise<void> {
  await createAdminClient().storage.from(LOGO_BUCKET).remove([path]);
}
