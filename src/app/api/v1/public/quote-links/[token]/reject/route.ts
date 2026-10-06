import {
  isSameOriginPost,
  passTokenGate,
  publicText,
  tooManyRequests,
} from "@/lib/share/public-request";
import { respondFromRequest } from "@/lib/share/respond-request";

export const runtime = "nodejs";

/**
 * Rechazar la cotización desde el enlace del cliente (H-031). El motivo es obligatorio: sin motivo
 * válido no se registra nada. Mismo orden de comprobaciones que `accept`.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/public/quote-links/[token]/reject">,
) {
  if (!isSameOriginPost(request)) return publicText("Solicitud no permitida.", 403);

  const { token } = await context.params;
  const gate = await passTokenGate(token);
  if (!gate.ok) {
    return gate.reason === "rate_limited"
      ? tooManyRequests()
      : publicText("Este enlace no está disponible.", 404);
  }

  return respondFromRequest(request, token, "rejected");
}
