import { NextResponse, type NextRequest } from "next/server";
import { HOME_PATH, LOGIN_NOTICES, LOGIN_PATH } from "@/lib/auth/paths";
import { createClient } from "@/lib/supabase/server";

/**
 * Llegada desde el enlace del correo de verificación (H-001).
 * Cambia el código del enlace por una sesión. Si el enlace caducó, ya se usó o se abrió en otro
 * navegador, lleva a ingresar con un aviso: el correo puede haber quedado verificado igual.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (searchParams.get("error") || !code) {
    return NextResponse.redirect(`${origin}${LOGIN_PATH}?aviso=${LOGIN_NOTICES.linkExpired}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}${LOGIN_PATH}?aviso=${LOGIN_NOTICES.verified}`);
  }
  return NextResponse.redirect(`${origin}${HOME_PATH}`);
}
