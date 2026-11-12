/**
 * ÚNICO lugar donde se valida el pase de sesión (STACK.md §5b, punto 3).
 *
 * Ningún otro archivo valida ni decodifica el pase por su cuenta. El día que la identidad venga de
 * un hub, se cambia solo este archivo.
 *
 * - `getSessionState` / `getOptionalUser` / `requireUser`: verifican el pase con el servidor de autenticación
 *   (`auth.getUser()`), nunca con `getSession()` a secas, que no verifica nada. Como consulta a
 *   Supabase Auth, un pase de una sesión ya cerrada no pasa: el cierre de sesión es efectivo.
 * - La verificación en dos pasos (H-004a): una sesión con la contraseña correcta pero sin el código es PARCIAL y
 *   no da acceso a nada (`getOptionalUser` devuelve nada, `requireUser` manda a la pantalla del código).
 *   Esa decisión vive solo aquí; ninguna pantalla ni acción la repite.
 * - `refreshSession`: lo usa el proxy (`src/proxy.ts`) en cada petición para renovar el pase antes
 *   de que venza, porque los componentes de servidor no pueden escribir cookies. El proxy solo
 *   renueva; nunca decide quién entra.
 * - La puerta de términos: si falta aceptar alguna versión vigente, `requireUser` redirige a
 *   "Acepta la nueva versión".
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { cache } from "react";
import { ACCEPT_TERMS_PATH, HOME_PATH, LOGIN_PATH, SECOND_STEP_PATH } from "@/lib/auth/paths";
import { hardenCookieOptions } from "@/lib/supabase/cookies";
import { createClient } from "@/lib/supabase/server";

export type SessionUser = {
  id: string;
  email: string;
  emailVerified: boolean;
};

/**
 * Estado de la sesión. Es el ÚNICO lugar donde se decide si una sesión sirve (H-004a):
 *
 * - `signed_out`: sin pase válido.
 * - `second_step_pending` (sesión parcial): la contraseña fue correcta (pase aal1), pero la cuenta tiene la
 *   verificación en dos pasos activa y falta el código. No da acceso a nada: solo a la pantalla del código y a
 *   cerrar sesión.
 * - `complete`: sin verificación en dos pasos activa, o con ella y el código ya verificado (pase aal2).
 *
 * `secondStep` dice si la cuenta tiene la verificación activa y desde cuándo (fecha en que se creó el factor).
 */
export type SessionState =
  | { status: "signed_out" }
  | {
      status: "second_step_pending";
      user: SessionUser;
      /** El factor de aplicación de códigos ya verificado contra el que se escribe el código (`null` si no hay). */
      factorId: string | null;
    }
  | {
      status: "complete";
      user: SessionUser;
      secondStep: { active: boolean; since: string | null };
    };

/** Nivel de seguridad del pase que significa «contraseña y código». */
const SECOND_STEP_ASSURANCE_LEVEL = "aal2";

/**
 * Estado de la sesión actual. Verifica el pase con el servidor de autenticación (`getUser`, que trae los factores
 * al día). Solo si la cuenta tiene un factor VERIFICADO se mira además el nivel del pase (`getClaims`): las cuentas
 * sin verificación en dos pasos no pagan nada extra. Ante cualquier duda (por ejemplo, `getClaims` falla), la sesión
 * se trata como parcial: es el lado seguro.
 */
export const getSessionState = cache(async (): Promise<SessionState> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { status: "signed_out" };
  const user: SessionUser = {
    id: data.user.id,
    email: data.user.email ?? "",
    emailVerified: data.user.email_confirmed_at != null,
  };

  const verified = (data.user.factors ?? []).filter((factor) => factor.status === "verified");
  if (verified.length === 0) {
    return { status: "complete", user, secondStep: { active: false, since: null } };
  }

  const { data: claims, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || claims?.claims.aal !== SECOND_STEP_ASSURANCE_LEVEL) {
    const totp = verified.find((factor) => factor.factor_type === "totp");
    return { status: "second_step_pending", user, factorId: totp?.id ?? null };
  }
  const since = verified.map((factor) => factor.created_at).sort()[0] ?? null;
  return { status: "complete", user, secondStep: { active: true, since } };
});

/**
 * Usuario con sesión COMPLETA, o `null`. Una sesión parcial (falta el código de la verificación en dos pasos)
 * devuelve `null`: las rutas de la API que lo usan como control de acceso responden 401 sin tocarlas.
 */
export const getOptionalUser = cache(async (): Promise<SessionUser | null> => {
  const state = await getSessionState();
  return state.status === "complete" ? state.user : null;
});

/** Cookie de corta vida que deja `/auth/recuperar` al canjear el enlace del correo (H-003). */
const RECOVERY_COOKIE = "cp_recovery";
const RECOVERY_COOKIE_MAX_AGE_SECONDS = 15 * 60;
/** Métodos con que Supabase marca una sesión nacida de un enlace del correo. */
const EMAIL_LINK_METHODS = new Set(["otp", "recovery"]);

/** Marca la sesión recién abierta con el enlace de recuperación. Solo `/auth/recuperar` la llama. */
export async function markRecoverySession(): Promise<void> {
  const store = await cookies();
  store.set(RECOVERY_COOKIE, "1", {
    ...hardenCookieOptions(undefined),
    // Lax a propósito: el enlace llega desde el correo (otro sitio) y Strict no enviaría la marca.
    path: "/",
    maxAge: RECOVERY_COOKIE_MAX_AGE_SECONDS,
  });
}

export async function clearRecoverySession(): Promise<void> {
  const store = await cookies();
  store.delete(RECOVERY_COOKIE);
}

/**
 * ¿La sesión actual nació del enlace de recuperación del correo? Exige dos señales a la vez:
 * la marca que dejó `/auth/recuperar` y que el pase verificado diga que la sesión se abrió con un
 * enlace del correo (`amr`: `otp`; Supabase no usa `recovery` aquí) y no con contraseña. Una
 * sesión normal, aunque alguien le agregue la cookie, no pasa.
 */
export async function hasRecoverySession(): Promise<boolean> {
  const store = await cookies();
  if (store.get(RECOVERY_COOKIE)?.value !== "1") return false;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return false;
  const methods = (data.claims.amr ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.method,
  );
  return methods.some((m) => EMAIL_LINK_METHODS.has(m)) && !methods.includes("password");
}

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

/**
 * Devuelve al usuario con sesión COMPLETA, o redirige: sin sesión a ingresar; con sesión parcial (falta el código de
 * la verificación en dos pasos) a la pantalla del código, ANTES de mirar los términos; y, si faltan términos
 * vigentes por aceptar, a «Acepta la nueva versión».
 */
export async function requireUser(options: RequireUserOptions = {}): Promise<SessionUser> {
  const state = await getSessionState();
  if (state.status === "signed_out") redirect(LOGIN_PATH);
  if (state.status === "second_step_pending") redirect(SECOND_STEP_PATH);
  if (!options.skipLegalGate && !(await hasAcceptedCurrentLegal(state.user.id))) {
    redirect(ACCEPT_TERMS_PATH);
  }
  return state.user;
}

/**
 * Para la pantalla del código y sus acciones: devuelve a la persona SOLO si su sesión es parcial. Sin sesión va a
 * ingresar; con sesión completa, al inicio (no tiene nada que verificar). Nunca redirige una sesión parcial.
 */
export async function requirePendingSecondStep(): Promise<SessionUser> {
  const state = await getSessionState();
  if (state.status === "signed_out") redirect(LOGIN_PATH);
  if (state.status === "complete") redirect(HOME_PATH);
  return state.user;
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
