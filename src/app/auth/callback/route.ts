import { NextResponse, type NextRequest } from "next/server";
import { HOME_PATH, LOGIN_NOTICES, LOGIN_PATH } from "@/lib/auth/paths";
import { getAppOrigin } from "@/lib/http/request-context";
import { createClient } from "@/lib/supabase/server";
import { INVITATION_ACCEPT_PATH } from "@/lib/team/accept-model";
import { hasPendingInvitation } from "@/lib/team/invitation-cookie";

/**
 * Llegada desde el enlace del correo de verificación (H-001). Desde H-116 el registro ya no envía este enlace (el correo del
 * registro lleva a `/confirmar-correo`): queda solo para los enlaces enviados ANTES del cambio, que valen su hora de vida. Quien
 * llega con uno cae en el inicio, y el control de entrada (`requireUser`) lo manda a terminar de crear su cuenta si todavía no
 * lo hizo (`/crear-cuenta`).
 * Cambia el código del enlace por una sesión. Si el enlace caducó, ya se usó o se abrió en otro
 * navegador, lleva a ingresar con un aviso: el correo puede haber quedado verificado igual.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const origin = getAppOrigin();
  const code = searchParams.get("code");

  if (searchParams.get("error") || !code) {
    return NextResponse.redirect(`${origin}${LOGIN_PATH}?aviso=${LOGIN_NOTICES.linkExpired}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}${LOGIN_PATH}?aviso=${LOGIN_NOTICES.linkNotUsable}`);
  }
  // Quien se registró desde el enlace de una invitación (y verifica su correo en este mismo navegador) vuelve
  // a ella para unirse (H-009). Si lo verificó en otro dispositivo no hay cookie: el inicio se lo recuerda.
  const next = (await hasPendingInvitation()) ? INVITATION_ACCEPT_PATH : HOME_PATH;
  return NextResponse.redirect(`${origin}${next}`);
}
