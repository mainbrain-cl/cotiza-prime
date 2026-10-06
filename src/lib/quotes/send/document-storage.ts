import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin-client";

/**
 * Archivos congelados de un envío (H-029): el PDF y el logo que recibió el cliente.
 *
 * Es el ÚNICO lugar del módulo de cotizaciones que usa la llave maestra, y solo sobre el bucket
 * privado `quote-documents`: nadie con sesión puede subir, cambiar ni borrar ahí (migración 20). Quien
 * llama ya resolvió la organización con `requireActiveTenant` y ya tiene el paquete creado con
 * `prepare_quote_send`; las rutas se arman aquí solo con el `tenant_id` de la organización activa, y
 * `attach_quote_package_document` vuelve a verificar en la base que el archivo exista en esa carpeta.
 * Se sube con `upsert: false`: un archivo congelado nunca se reemplaza.
 */
export const QUOTE_DOCUMENTS_BUCKET = "quote-documents";
export const PDF_CONTENT_TYPE = "application/pdf";

export type LogoFormat = "png" | "jpg";
const LOGO_CONTENT_TYPES: Record<LogoFormat, string> = { png: "image/png", jpg: "image/jpeg" };

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Ruta del PDF: `{tenant_id}/{quote_id}/{package_id}.pdf`. */
export function packagePdfPath(tenantId: string, quoteId: string, packageId: string): string {
  return `${tenantId}/${quoteId}/${packageId}.pdf`;
}

/** Ruta del logo congelado: `{tenant_id}/{quote_id}/{package_id}-logo.{png|jpg}`. */
export function packageLogoPath(
  tenantId: string,
  quoteId: string,
  packageId: string,
  format: LogoFormat,
): string {
  return `${tenantId}/${quoteId}/${packageId}-logo.${format}`;
}

export async function uploadPackagePdf(path: string, bytes: Uint8Array): Promise<boolean> {
  const { error } = await createAdminClient()
    .storage.from(QUOTE_DOCUMENTS_BUCKET)
    .upload(path, bytes, { contentType: PDF_CONTENT_TYPE, upsert: false });
  return !error;
}

export async function uploadPackageLogo(
  path: string,
  bytes: Uint8Array,
  format: LogoFormat,
): Promise<boolean> {
  const { error } = await createAdminClient()
    .storage.from(QUOTE_DOCUMENTS_BUCKET)
    .upload(path, bytes, { contentType: LOGO_CONTENT_TYPES[format], upsert: false });
  return !error;
}

/**
 * Lee el PDF congelado. Si se da `expectedSha256`, devuelve `null` cuando el archivo no coincide:
 * lo enviado tiene que ser exactamente lo guardado.
 */
export async function readPackagePdf(
  path: string,
  expectedSha256?: string,
): Promise<Uint8Array | null> {
  const { data, error } = await createAdminClient()
    .storage.from(QUOTE_DOCUMENTS_BUCKET)
    .download(path);
  if (error || !data) return null;
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (expectedSha256 && sha256Hex(bytes) !== expectedSha256) return null;
  return bytes;
}
