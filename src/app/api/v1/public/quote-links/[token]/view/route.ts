import { getRequestContext } from "@/lib/http/request-context";
import { serverLog } from "@/lib/log/server-log";
import { readShareLink, recordShareView } from "@/lib/share/gateway";
import {
  isSameOriginPost,
  passTokenGate,
  publicJson,
  publicText,
  tooManyRequests,
} from "@/lib/share/public-request";
import { isAvailable } from "@/lib/share/read-model";
import { isViewerMemberOf } from "@/lib/share/viewer";

export const runtime = "nodejs";

/**
 * Aviso de apertura (H-030): la página lo manda DESPUÉS de mostrarse. Es la única forma de registrar
 * una apertura: un GET (que es lo que abren solos los antivirus y las vistas previas de los
 * mensajes) nunca cambia nada. Si quien abre tiene sesión y es miembro de la organización, no
 * cuenta. La IP y el navegador salen de la petición en el servidor, nunca de lo que mande el cliente.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/public/quote-links/[token]/view">,
) {
  if (!isSameOriginPost(request)) return publicText("Solicitud no permitida.", 403);

  const { token } = await context.params;
  const gate = await passTokenGate(token);
  if (!gate.ok) {
    return gate.reason === "rate_limited"
      ? tooManyRequests()
      : publicText("Este enlace no está disponible.", 404);
  }

  try {
    const link = await readShareLink(token);
    if (!isAvailable(link)) return publicJson({ recorded: false });
    if (await isViewerMemberOf(link.tenantId)) {
      return publicJson({ recorded: false, reason: "member" });
    }
    const { clientIp, userAgent } = await getRequestContext();
    const result = await recordShareView(token, link, { ip: clientIp, userAgent });
    return publicJson({ recorded: result.recorded });
  } catch {
    await serverLog("error", "share_view_failed");
    return publicText("No pudimos registrar la apertura.", 500);
  }
}
