/**
 * Política de contenido para el logo servido por `/api/v1/tenants/{id}/logo`: aunque alguien abra la
 * dirección directo en el navegador, el archivo no puede ejecutar nada ni cargar recursos externos.
 * La usan la ruta y `next.config.ts` (que si no, pondría encima la política general de la aplicación).
 */
export const LOGO_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox";
