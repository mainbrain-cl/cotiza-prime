import type { NextRequest } from "next/server";
import { refreshSession } from "@/lib/auth/session";

/** Renueva el pase de sesión en cada petición. No decide accesos (eso es `requireUser`). */
export async function proxy(request: NextRequest) {
  return refreshSession(request);
}

export const config = {
  matcher: [
    // Todo menos archivos estáticos, imágenes optimizadas y el ícono
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
