/**
 * Rutas de los archivos congelados de un envío (H-029), en el bucket privado `quote-documents`.
 * Sin dependencias del servidor: se pueden probar solas. Quien toca el almacenamiento con la llave
 * maestra (`document-storage.ts`) verifica CADA ruta con `assertPackagePath` antes de usarla.
 */
export type LogoFormat = "png" | "jpg";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PDF_PATH = new RegExp(`^(${UUID})/(${UUID})/(${UUID})\\.pdf$`);
const LOGO_PATH = new RegExp(`^(${UUID})/(${UUID})/(${UUID})-logo\\.(png|jpg|svg)$`);

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

export class PackagePathError extends Error {
  constructor() {
    super("invalid_package_path");
    this.name = "PackagePathError";
  }
}

/** ¿La ruta es de un PDF o un logo congelado, y está dentro de la carpeta de esta organización? */
export function isPackagePath(tenantId: string, path: string, kind?: "pdf" | "logo"): boolean {
  if (typeof path !== "string" || typeof tenantId !== "string") return false;
  if (!new RegExp(`^${UUID}$`).test(tenantId)) return false;
  const match =
    (kind !== "logo" ? PDF_PATH.exec(path) : null) ??
    (kind !== "pdf" ? LOGO_PATH.exec(path) : null);
  return match !== null && match[1] === tenantId;
}

/** Lanza si la ruta no es de esta organización o no tiene la forma esperada (nunca confía en lo que recibe). */
export function assertPackagePath(tenantId: string, path: string, kind?: "pdf" | "logo"): void {
  if (!isPackagePath(tenantId, path, kind)) throw new PackagePathError();
}
