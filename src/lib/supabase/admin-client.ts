import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Cliente con la llave maestra (`service_role`): se salta TODA la seguridad por fila.
 *
 * Reglas (docs/arquitectura/modelo-datos.md §4.6):
 * - Solo se importa desde `src/lib/audit/`, `src/lib/security/`, `src/lib/brand/logo-storage.ts`, `src/lib/quotes/send/document-storage.ts`, `src/lib/share/gateway.ts`, `src/lib/intake/gateway.ts`, `src/lib/team/gateway.ts`, `src/lib/email/delivery-events-service.ts`, `src/server/jobs/`, `scripts/` y `tests/`; una regla
 *   del linter lo exige.
 * - Nunca se usa para leer ni escribir datos de negocio en respuesta a una petición de usuario.
 * - La llave nunca lleva el prefijo `NEXT_PUBLIC_`.
 *
 * `headers` (opcional): cabeceras que viajan en cada llamada (p. ej. el identificador de la petición,
 * para que la auditoría quede correlacionada).
 */
export function createAdminClient(headers?: Record<string, string>) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Falta NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(headers ? { global: { headers } } : {}),
  });
}
