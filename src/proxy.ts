import type { NextRequest } from "next/server";
import { refreshSession } from "@/lib/auth/session";

/** Renueva el pase de sesión en cada petición. No decide accesos (eso es `requireUser`). */
export async function proxy(request: NextRequest) {
  return refreshSession(request);
}

export const config = {
  matcher: [
    // Todo menos archivos estáticos, imágenes optimizadas y el ícono, y menos lo público sin cuenta: el
    // formulario público (`/f/*`) y la API pública (`/api/v1/public/*`) no leen ni renuevan la sesión.
    "/((?!_next/static|_next/image|favicon.ico|f/|api/v1/public/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
