import { NextResponse, type NextRequest } from "next/server";
import { LOGIN_NOTICES, LOGIN_PATH, RESET_PASSWORD_PATH } from "@/lib/auth/paths";
import { markRecoverySession } from "@/lib/auth/session";
import { getAppOrigin } from "@/lib/http/request-context";
import { createClient } from "@/lib/supabase/server";

/**
 * Llegada desde el enlace del correo de restablecer contraseña (H-003).
 * Cambia el código del enlace por una sesión y lleva a elegir la contraseña nueva. Si el enlace
 * caducó, ya se usó o se abrió en otro navegador, lleva a ingresar con un aviso.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const origin = getAppOrigin();
  const code = searchParams.get("code");
  const failure = `${origin}${LOGIN_PATH}?aviso=${LOGIN_NOTICES.resetLinkExpired}`;

  if (searchParams.get("error") || !code) return NextResponse.redirect(failure);

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(failure);
  await markRecoverySession();
  return NextResponse.redirect(`${origin}${RESET_PASSWORD_PATH}`);
}
