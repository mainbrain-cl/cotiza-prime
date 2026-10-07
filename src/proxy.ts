import { NextResponse, type NextRequest } from "next/server";
import { refreshSession } from "@/lib/auth/session";
import { buildEmbedResponseHeaders, parseEmbedPath } from "@/lib/intake/embed-headers";
import { readFrameAncestors } from "@/lib/intake/gateway";

/**
 * Renueva el pase de sesión en cada petición. No decide accesos (eso es `requireUser`).
 *
 * Excepción (H-093): el formulario incrustable `/f/<id>/incrustar` NO toca la sesión (es público, sin cuenta) y
 * aquí se arma su cabecera `Content-Security-Policy` con SOLO los sitios que ese formulario autorizó
 * (`frame-ancestors`). Si la lista está vacía, el formulario no existe o falla la lectura, queda `'none'`.
 * `next.config.ts` deja esta ruta fuera de la regla global de `X-Frame-Options: DENY`.
 */
export async function proxy(request: NextRequest) {
  const embed = parseEmbedPath(request.nextUrl.pathname);
  if (embed) {
    const origins = await readFrameAncestors(embed.publicId);
    const response = NextResponse.next();
    const headers = buildEmbedResponseHeaders(origins, {
      isDev: process.env.NODE_ENV !== "production",
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      antibotProvider: process.env.ANTIBOT_PROVIDER,
    });
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  }
  return refreshSession(request);
}

export const config = {
  matcher: [
    // Todo menos archivos estáticos, imágenes optimizadas y el ícono, y menos lo público sin cuenta: el
    // formulario público (`/f/*`) y la API pública (`/api/v1/public/*`) no leen ni renuevan la sesión.
    "/((?!_next/static|_next/image|favicon.ico|f/|api/v1/public/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
    // La única ruta de `/f/*` que pasa por aquí: el formulario incrustable (solo para sus cabeceras).
    // (Literal a propósito: Next exige que el `matcher` se pueda leer sin ejecutar nada. Una prueba vigila que
    // sea igual a `EMBED_PROXY_MATCHER`.)
    "/f/:publicId/incrustar",
  ],
};
