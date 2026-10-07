/**
 * Política de seguridad de contenido (CSP) de la aplicación. Vive aparte para que la usen igual
 * `next.config.ts` (todas las rutas) y `src/proxy.ts` (el formulario incrustable, H-093, cuya lista de
 * `frame-ancestors` cambia por formulario). Sin dependencias del servidor: se puede importar desde ambos.
 */

export type CspOptions = {
  /** Valor de `frame-ancestors`: `'none'`, `'self'` o una lista de sitios ya validados. */
  frameAncestors: string;
  /** Solo el formulario público con Turnstile: Cloudflare carga su script y su marco desde aquí. */
  antibotHost?: string;
  isDev: boolean;
  supabaseUrl: string;
};

// CSP inicial. Next.js inserta scripts en línea, por eso 'unsafe-inline' en script-src;
// más adelante se puede pasar a una CSP con nonce. 'unsafe-eval' solo en desarrollo.
export function buildContentSecurityPolicy({
  frameAncestors,
  antibotHost,
  isDev,
  supabaseUrl,
}: CspOptions): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}${antibotHost ? ` ${antibotHost}` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabaseUrl}${isDev ? " ws: wss:" : ""}`.trim(),
    ...(antibotHost ? [`frame-src ${antibotHost}`] : []),
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

export const TURNSTILE_HOST = "https://challenges.cloudflare.com";

/** Cabecera de transporte seguro: la misma en la regla global y en el formulario incrustable. */
export const HSTS_VALUE = "max-age=63072000; includeSubDomains; preload";
