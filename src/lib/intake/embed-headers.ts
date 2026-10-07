/**
 * Cabeceras del formulario incrustable (H-093), sin dependencias del servidor: las usan `next.config.ts` (para
 * dejar la ruta fuera de la regla que prohíbe enmarcar) y `src/proxy.ts` (para armar su política con la lista de
 * sitios de cada formulario).
 *
 * Por qué así: `X-Frame-Options` no admite una lista de sitios, así que en esta ruta NO se envía; la autoriza
 * `frame-ancestors`. Todo lo demás (`/o/*`, `/c/*`, `/f/[id]`, el PDF, la API) sigue con `DENY` y `'none'`.
 */

import { EMBED_PATH_SEGMENT, embedFrameAncestors } from "./embed";
import { HSTS_VALUE, TURNSTILE_HOST, buildContentSecurityPolicy } from "../security/csp";

/**
 * `source` de la regla global de `next.config.ts`: todo MENOS `/f/<id>/incrustar`. Es una expresión regular de
 * Next (`/:param(regex)`), con un `(?!…)` que deja fuera solo esa ruta.
 */
export const EMBED_ROUTE_EXCLUSION = `/:path((?!f/[^/]+/${EMBED_PATH_SEGMENT}$).*)`;

/** `matcher` del `proxy` para esa ruta (se suma al general, que excluye `f/`). */
export const EMBED_PROXY_MATCHER = `/f/:publicId/${EMBED_PATH_SEGMENT}`;

/** Segundo `matcher` del `proxy`: la misma ruta con cualquier combinación de mayúsculas (ver `isEmbedPathLookalike`). */
export const EMBED_PROXY_CASE_MATCHER = `/f/:publicId/:segment(${[...EMBED_PATH_SEGMENT]
  .map((letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`)
  .join("")})`;

const EMBED_PATH = new RegExp(`^/f/([^/]+)/${EMBED_PATH_SEGMENT}$`);
const EMBED_PATH_INSENSITIVE = new RegExp(`^/f/[^/]+/${EMBED_PATH_SEGMENT}$`, "i");

/** Si la ruta es la del formulario incrustable devuelve el identificador tal como vino; si no, `null`. */
export function parseEmbedPath(pathname: string): { publicId: string } | null {
  const match = EMBED_PATH.exec(pathname);
  return match ? { publicId: match[1] } : null;
}

/**
 * Next compara las rutas SIN distinguir mayúsculas (la exclusión de `next.config.ts` deja sin `X-Frame-Options`
 * también `/F/<id>/INCRUSTAR`), pero `parseEmbedPath` sí distingue. Esas variantes no son el formulario
 * incrustable: el proxy las responde con `DENY` y la política base (`frame-ancestors 'none'`).
 */
export function isEmbedPathLookalike(pathname: string): boolean {
  return parseEmbedPath(pathname) === null && EMBED_PATH_INSENSITIVE.test(pathname);
}

/**
 * Valor de `frame-ancestors` para esa lista. Cualquier problema (lista dudosa, demasiado larga) deja `'none'`:
 * nunca se arma una política con texto sin validar.
 */
export function safeFrameAncestors(origins: readonly string[]): string {
  try {
    return embedFrameAncestors(origins);
  } catch {
    return "'none'";
  }
}

export type EmbedHeaderEnv = { isDev: boolean; supabaseUrl: string; antibotProvider?: string };

/**
 * Las cabeceras de seguridad de `/f/<id>/incrustar`: la política general (con Cloudflare abierto si el
 * anti-robot es Turnstile) y SOLO los sitios autorizados en `frame-ancestors`. Sin `X-Frame-Options`, sin
 * CORS. El resto (`Cache-Control`, `X-Robots-Tag`, `Referrer-Policy`, `nosniff`) las pone la regla `/f/:path*`
 * de `next.config.ts`; aquí se repiten para que no dependan del orden en que Next las junta.
 */
export function buildEmbedResponseHeaders(
  origins: readonly string[],
  env: EmbedHeaderEnv,
): Record<string, string> {
  return {
    "Content-Security-Policy": buildContentSecurityPolicy({
      frameAncestors: safeFrameAncestors(origins),
      antibotHost: env.antibotProvider === "turnstile" ? TURNSTILE_HOST : undefined,
      isDev: env.isDev,
      supabaseUrl: env.supabaseUrl,
    }),
    "Strict-Transport-Security": HSTS_VALUE,
    "Cache-Control": "private, no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

/** Cabeceras de las variantes con otras mayúsculas de la ruta incrustable: no se pueden enmarcar en ningún sitio. */
export function buildEmbedLookalikeHeaders(env: EmbedHeaderEnv): Record<string, string> {
  return { ...buildEmbedResponseHeaders([], env), "X-Frame-Options": "DENY" };
}
