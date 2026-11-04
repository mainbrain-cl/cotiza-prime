import { NextResponse, type NextRequest } from "next/server";
import { getAppOrigin, getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { consumeInvitationLinkQuota } from "@/lib/security/login-rate-limit";
import {
  INVITATION_ACCEPT_PATH,
  INVITATION_COOKIE_NAME,
  INVITATION_NOTICES,
} from "@/lib/team/accept-model";
import { isWellFormedInvitationToken } from "@/lib/team/invitation-code";
import { invitationCookieOptions } from "@/lib/team/invitation-cookie";

export const runtime = "nodejs";

/** Nada de esta respuesta se guarda en cachés, y la dirección con el código no se filtra a otros sitios. */
const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

function leave(origin: string, notice?: string): NextResponse {
  const target = `${origin}${INVITATION_ACCEPT_PATH}${notice ? `?aviso=${notice}` : ""}`;
  const response = NextResponse.redirect(target, { status: 303, headers: RESPONSE_HEADERS });
  return response;
}

/**
 * El enlace del correo de una invitación (H-009): `/invitacion/[código]`. NO acepta nada y NO consulta la base
 * de datos: comprueba que el código tenga la forma de un código, aplica el límite de aperturas por IP, guarda el
 * código en una cookie (`HttpOnly`, una hora) y redirige a `/invitacion`. Así el código sale de la barra de
 * direcciones y del historial. Aceptar exige sesión y un clic en esa pantalla, y lo decide la base de datos.
 *
 * Es un GET que solo deja una cookie en quien lo abre: si un antivirus abre el enlace antes que la persona, no
 * cambia nada en la invitación.
 */
export async function GET(_request: NextRequest, context: RouteContext<"/invitacion/[token]">) {
  const { token } = await context.params;
  const origin = getAppOrigin();

  if (!isWellFormedInvitationToken(token)) {
    // Un código viejo guardado antes no se queda: este enlace es el más reciente que la persona abrió.
    const response = leave(origin, INVITATION_NOTICES.malformed);
    response.cookies.delete(INVITATION_COOKIE_NAME);
    return response;
  }

  const { clientIp } = await getRequestContext();
  if (!(await consumeInvitationLinkQuota(clientIp))) {
    await serverLog("warn", "invitation_link_rate_limited");
    // Igual que con un enlace mal formado: el código de un enlace anterior no se queda esperando.
    const blocked = leave(origin, INVITATION_NOTICES.tooMany);
    blocked.cookies.delete(INVITATION_COOKIE_NAME);
    return blocked;
  }

  const response = leave(origin);
  response.cookies.set(INVITATION_COOKIE_NAME, token, invitationCookieOptions());
  return response;
}
