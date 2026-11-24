import { NextResponse, type NextRequest } from "next/server";
import {
  CREATE_ACCOUNT_PATH,
  LOGIN_NOTICES,
  LOGIN_PATH,
  RESET_PASSWORD_PATH,
} from "@/lib/auth/paths";
import { markRecoverySession } from "@/lib/auth/session";
import { getAppOrigin } from "@/lib/http/request-context";
import { createClient } from "@/lib/supabase/server";

/**
 * Llegada desde el enlace del correo de restablecer contraseña (H-003).
 * Cambia el código del enlace por una sesión y lleva a elegir la contraseña nueva. Si el enlace
 * caducó, ya se usó o se abrió en otro navegador, lleva a ingresar con un aviso.
 *
 * H-116: si la cuenta todavía NO está terminada (quien pidió «¿Olvidaste tu contraseña?» en una cuenta que nunca terminó de
 * crear), va a `/crear-cuenta` en vez de `/restablecer-contrasena`: un solo lugar fija la primera contraseña, y ahí también se
 * eligen el nombre y los términos. Si la base no responde la pregunta (por ejemplo, la cuenta tiene el segundo paso activo y falta
 * el código), se sigue por el camino de siempre: esa pantalla lo resuelve.
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
  const ready = await supabase.rpc("my_account_ready");
  if (!ready.error && ready.data === false) {
    return NextResponse.redirect(`${origin}${CREATE_ACCOUNT_PATH}`);
  }
  await markRecoverySession();
  return NextResponse.redirect(`${origin}${RESET_PASSWORD_PATH}`);
}
