import { handleIntakeSubmit } from "@/lib/intake/submit-service";
import { isSameOriginPost, publicText } from "@/lib/share/public-request";

export const runtime = "nodejs";

/**
 * Enviar una solicitud por el formulario público (H-087). Alguien SIN CUENTA entrega datos personales:
 * lo primero, antes que cualquier otra cosa, es comprobar que el envío viene de nuestra propia página
 * (`Origin`). Todo lo demás (identificador, límites por IP, cuerpo, trampas, anti-robot, validación,
 * cifrado y base de datos) lo hace `handleIntakeSubmit`, en un orden fijo. Esta ruta no habla con la base
 * ni usa la llave maestra: solo el portero (`src/lib/intake/gateway.ts`) lo hace. Sin CORS.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/public/forms/[publicId]/requests">,
) {
  if (!isSameOriginPost(request)) return publicText("Solicitud no permitida.", 403);

  const { publicId } = await context.params;
  return handleIntakeSubmit(request, publicId);
}
