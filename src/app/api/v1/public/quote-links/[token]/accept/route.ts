import {
  isSameOriginPost,
  passTokenGate,
  publicText,
  tooManyRequests,
} from "@/lib/share/public-request";
import { respondFromRequest } from "@/lib/share/respond-request";

export const runtime = "nodejs";
/**
 * Segundos que la plataforma deja correr la petición: lo que va después de responder (`after`: el correo con los datos para pagar
 * y los avisos al equipo, cada uno con su plazo de 20 s) corre dentro de este tope.
 */
export const maxDuration = 60;

/**
 * Aceptar la cotización desde el enlace del cliente (H-031). Es un registro de conformidad, no una
 * firma electrónica avanzada. El orden es fijo: origen, forma del token y límites de lectura, y
 * recién entonces el cuerpo (validación, límite de respuestas por IP y base de datos).
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/public/quote-links/[token]/accept">,
) {
  if (!isSameOriginPost(request)) return publicText("Solicitud no permitida.", 403);

  const { token } = await context.params;
  const gate = await passTokenGate(token);
  if (!gate.ok) {
    return gate.reason === "rate_limited"
      ? tooManyRequests()
      : publicText("Este enlace no está disponible.", 404);
  }

  return respondFromRequest(request, token, "accepted");
}
