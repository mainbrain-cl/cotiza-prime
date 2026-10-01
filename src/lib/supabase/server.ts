import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { hardenCookieOptions } from "./cookies";

/**
 * Cliente de Supabase para el servidor (componentes, route handlers y server actions).
 *
 * `extraHeaders` existe para que `src/lib/tenant/active-tenant.ts` entregue el cliente con la
 * organización activa ya puesta. Nadie más arma esas cabeceras.
 */
export async function createClient(extraHeaders?: Record<string, string>) {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: extraHeaders ? { headers: extraHeaders } : undefined,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, hardenCookieOptions(options)),
            );
          } catch {
            // Se llamó desde un componente de servidor, que no puede escribir cookies.
            // Es seguro ignorarlo: el proxy (src/proxy.ts) refresca la sesión en cada petición.
          }
        },
      },
    },
  );
}
