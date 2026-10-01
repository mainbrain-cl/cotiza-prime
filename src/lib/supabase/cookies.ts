import type { CookieOptions } from "@supabase/ssr";

/**
 * Cookies de sesión endurecidas (SEGURIDAD.md §5): `HttpOnly`, `Secure` fuera de desarrollo y
 * `SameSite=Lax`. Toda la autenticación ocurre en el servidor, así que el navegador nunca necesita
 * leer estas cookies desde JavaScript.
 */
export function hardenCookieOptions(options: CookieOptions | undefined): CookieOptions {
  return {
    ...options,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  };
}
