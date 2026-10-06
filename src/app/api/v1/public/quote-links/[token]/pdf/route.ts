import { serverLog } from "@/lib/log/server-log";
import { quotePdfFileName } from "@/lib/pdf/file-name";
import { readFrozenPdf, readShareLink } from "@/lib/share/gateway";
import {
  PUBLIC_RESPONSE_HEADERS,
  passTokenGate,
  publicText,
  tooManyRequests,
} from "@/lib/share/public-request";
import { isAvailable } from "@/lib/share/read-model";

export const runtime = "nodejs";

const NOT_AVAILABLE_MESSAGE = "Este enlace no está disponible.";
const VERSION_PATTERN = /(\d+)/;

/**
 * Descarga del PDF que recibió el cliente (H-030). Sin sesión: la puerta es el token del enlace.
 * Entrega SIEMPRE el archivo congelado al enviar (con su sello comprobado), nunca uno nuevo, y solo
 * mientras el enlace sigue vigente. Un GET nunca cambia nada. Token mal formado: se rechaza antes
 * de consultar la base de datos.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/v1/public/quote-links/[token]/pdf">,
) {
  const { token } = await context.params;
  const gate = await passTokenGate(token);
  if (!gate.ok) {
    return gate.reason === "rate_limited"
      ? tooManyRequests()
      : publicText(NOT_AVAILABLE_MESSAGE, 404);
  }

  let link: Awaited<ReturnType<typeof readShareLink>>;
  try {
    link = await readShareLink(token);
  } catch {
    await serverLog("error", "share_pdf_read_failed");
    return publicText("No pudimos obtener el PDF. Inténtalo de nuevo en un momento.", 500);
  }
  // Solo mientras el enlace sirve: vencido, revocado o reemplazado no entrega nada.
  if (!isAvailable(link)) {
    return publicText(NOT_AVAILABLE_MESSAGE, 404);
  }

  const bytes = await readFrozenPdf(link);
  if (bytes === null) {
    await serverLog("error", "share_frozen_pdf_missing");
    return publicText("No pudimos obtener el PDF. Inténtalo de nuevo en un momento.", 500);
  }
  const version = Number(VERSION_PATTERN.exec(link.document.quote.versionLabel ?? "")?.[1] ?? 1);
  const fileName = quotePdfFileName(link.document.quote.number, version);
  return new Response(new Uint8Array(bytes), {
    headers: {
      ...PUBLIC_RESPONSE_HEADERS,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
