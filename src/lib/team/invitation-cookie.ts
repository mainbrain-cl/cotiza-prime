import "server-only";
import { cookies } from "next/headers";
import { hardenCookieOptions } from "@/lib/supabase/cookies";
import {
  INVITATION_COOKIE_MAX_AGE_SECONDS,
  INVITATION_COOKIE_NAME,
  invitationCodeSchema,
} from "./accept-model";

/**
 * La cookie que lleva el código de una invitación (H-009) mientras la persona ingresa o se registra.
 *
 * Por qué una cookie: así el código sale de la barra de direcciones y del historial apenas se abre el enlace
 * del correo (`/invitacion/[código]` lo guarda y redirige a `/invitacion`). Es `HttpOnly` (la página no la lee),
 * `Secure` en producción, `SameSite=Lax` (el enlace llega desde el correo, otro sitio) y vale una hora.
 *
 * Esta cookie NUNCA decide nada por sí sola: es solo el código. Quién puede usarlo lo decide la base de datos
 * comparando el correo de la cuenta con el vínculo guardado.
 */

/** Las opciones de la cookie, para quien la escribe sobre una respuesta (la ruta del enlace). */
export function invitationCookieOptions() {
  return {
    ...hardenCookieOptions(undefined),
    path: "/",
    maxAge: INVITATION_COOKIE_MAX_AGE_SECONDS,
  };
}

/** El código guardado, o `null` si no hay cookie o no tiene la forma de un código. */
export async function readInvitationCode(): Promise<string | null> {
  const store = await cookies();
  const raw = store.get(INVITATION_COOKIE_NAME)?.value;
  if (!raw) return null;
  const parsed = invitationCodeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** ¿Hay una invitación esperando en este navegador? */
export async function hasPendingInvitation(): Promise<boolean> {
  return (await readInvitationCode()) !== null;
}

/** Borra el código: ya se usó, o ya no sirve. Solo desde acciones y rutas (un componente no puede escribir cookies). */
export async function clearInvitationCode(): Promise<void> {
  const store = await cookies();
  store.delete(INVITATION_COOKIE_NAME);
}
