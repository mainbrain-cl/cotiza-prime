/**
 * ÚNICO lugar donde se valida el pase de sesión (STACK.md §5b, punto 3).
 *
 * Ningún otro archivo valida ni decodifica el pase por su cuenta. El día que la identidad venga de
 * un hub, se cambia solo este archivo.
 *
 * - `getOptionalUser` / `requireUser`: verifican el pase con el servidor de autenticación
 *   (`auth.getUser()`), nunca con `getSession()` a secas, que no verifica nada. Como consulta a
 *   Supabase Auth, un pase de una sesión ya cerrada no pasa: el cierre de sesión es efectivo.
 * - `refreshSession`: lo usa el proxy (`src/proxy.ts`) en cada petición para renovar el pase antes
 *   de que venza, porque los componentes de servidor no pueden escribir cookies. El proxy solo
 *   renueva; nunca decide quién entra.
 * - La puerta de términos: si falta aceptar alguna versión vigente, `requireUser` redirige a
 *   "Acepta la nueva versión".
 */
import { createServerClient } from "@supabase/ssr";
import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { cache } from "react";
import { ACCEPT_TERMS_PATH, LOGIN_PATH } from "@/lib/auth/paths";
import { hardenCookieOptions } from "@/lib/supabase/cookies";
import { createClient } from "@/lib/supabase/server";

export type SessionUser = {
  id: string;
  email: string;
  emailVerified: boolean;
};

/** Usuario con sesión válida, o `null`. Verifica el pase con el servidor de autenticación. */
export const getOptionalUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return {
    id: data.user.id,
    email: data.user.email ?? "",
    emailVerified: data.user.email_confirmed_at != null,
  };
});

/** ¿Aceptó esta persona todas las versiones vigentes de términos y privacidad? */
const hasAcceptedCurrentLegal = cache(async (userId: string): Promise<boolean> => {
  const supabase = await createClient();
  const [current, accepted] = await Promise.all([
    supabase.from("legal_documents").select("id").eq("is_current", true),
    supabase.from("legal_acceptances").select("document_id").eq("user_id", userId),
  ]);
  // Ante una falla de lectura se asume que falta aceptar: es el lado seguro.
  if (current.error || accepted.error || !current.data) return false;
  const acceptedIds = new Set((accepted.data ?? []).map((row) => row.document_id));
  return current.data.every((doc) => acceptedIds.has(doc.id));
});

type RequireUserOptions = {
  /** Solo la pantalla "Acepta la nueva versión" lo usa: no puede exigir lo que está resolviendo. */
  skipLegalGate?: boolean;
};

/** Devuelve al usuario con sesión válida, o redirige a ingresar / a aceptar los términos vigentes. */
export async function requireUser(options: RequireUserOptions = {}): Promise<SessionUser> {
  const user = await getOptionalUser();
  if (!user) redirect(LOGIN_PATH);
  if (!options.skipLegalGate && !(await hasAcceptedCurrentLegal(user.id))) {
    redirect(ACCEPT_TERMS_PATH);
  }
  return user;
}

/** Para el proxy: renueva el pase de sesión y deja las cookies nuevas en la petición y la respuesta. */
export async function refreshSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headersToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, hardenCookieOptions(options)),
          );
          Object.entries(headersToSet ?? {}).forEach(([key, value]) =>
            response.headers.set(key, value),
          );
        },
      },
    },
  );

  // Sin decisiones aquí: solo dispara la renovación del pase si hace falta.
  await supabase.auth.getClaims();
  return response;
}
