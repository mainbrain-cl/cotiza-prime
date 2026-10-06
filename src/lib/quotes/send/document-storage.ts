import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin-client";
import { assertPackagePath, type LogoFormat } from "./package-paths";

/**
 * Archivos congelados de un envío (H-029): el PDF y el logo que recibió el cliente.
 *
 * Es el ÚNICO lugar del módulo de cotizaciones que usa la llave maestra, y solo sobre el bucket
 * privado `quote-documents`: nadie con sesión puede subir, cambiar ni borrar ahí (migración 20). Quien
 * llama ya resolvió la organización con `requireActiveTenant` y ya tiene el paquete creado con
 * `prepare_quote_send`. Como la llave maestra se salta los permisos del almacenamiento, TODA función
 * de este archivo recibe el `tenantId` y rechaza cualquier ruta que no sea de esa organización o no
 * tenga la forma `{uuid}/{uuid}/{uuid}.pdf` (o `-logo.{png|jpg|svg}`): una ruta ajena o manipulada no
 * llega nunca al almacenamiento. Se sube con `upsert: false`: un archivo congelado nunca se reemplaza.
 */
export const QUOTE_DOCUMENTS_BUCKET = "quote-documents";
export const PDF_CONTENT_TYPE = "application/pdf";

export { assertPackagePath, packageLogoPath, packagePdfPath } from "./package-paths";
export type { LogoFormat } from "./package-paths";

const LOGO_CONTENT_TYPES: Record<LogoFormat, string> = { png: "image/png", jpg: "image/jpeg" };

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export async function uploadPackagePdf(
  tenantId: string,
  path: string,
  bytes: Uint8Array,
): Promise<boolean> {
  assertPackagePath(tenantId, path, "pdf");
  const { error } = await createAdminClient()
    .storage.from(QUOTE_DOCUMENTS_BUCKET)
    .upload(path, bytes, { contentType: PDF_CONTENT_TYPE, upsert: false });
  return !error;
}

export async function uploadPackageLogo(
  tenantId: string,
  path: string,
  bytes: Uint8Array,
  format: LogoFormat,
): Promise<boolean> {
  assertPackagePath(tenantId, path, "logo");
  const { error } = await createAdminClient()
    .storage.from(QUOTE_DOCUMENTS_BUCKET)
    .upload(path, bytes, { contentType: LOGO_CONTENT_TYPES[format], upsert: false });
  return !error;
}

/**
 * Lee el PDF congelado. Si se da `expectedSha256`, devuelve `null` cuando el archivo no coincide:
 * lo enviado tiene que ser exactamente lo guardado. Una ruta que no es de esta organización lanza.
 */
export async function readPackagePdf(
  tenantId: string,
  path: string,
  expectedSha256?: string,
): Promise<Uint8Array | null> {
  assertPackagePath(tenantId, path, "pdf");
  const { data, error } = await createAdminClient()
    .storage.from(QUOTE_DOCUMENTS_BUCKET)
    .download(path);
  if (error || !data) return null;
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (expectedSha256 && sha256Hex(bytes) !== expectedSha256) return null;
  return bytes;
}
