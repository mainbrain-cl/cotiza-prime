import { notFound } from "next/navigation";
import { getOptionalUser } from "@/lib/auth/session";
import { serverLog } from "@/lib/log/server-log";
import { quotePdfFileName } from "@/lib/pdf/file-name";
import { loadQuoteDocumentData } from "@/lib/pdf/quote-document-data";
import { renderQuotePdf } from "@/lib/pdf/render";
import { PDF_PAPER_SIZES, type PdfPaperSize } from "@/lib/pdf/types";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";

export const runtime = "nodejs";

const DEFAULT_PAPER: PdfPaperSize = "letter";

function paperFrom(value: string | null): PdfPaperSize | null {
  if (value === null) return DEFAULT_PAPER;
  return (PDF_PAPER_SIZES as readonly string[]).includes(value) ? (value as PdfPaperSize) : null;
}

/**
 * PDF de una cotización (H-028), generado en el servidor con lo guardado. Solo para miembros de la
 * organización: quien no lo es, o una cotización que no existe en ella, recibe el mismo 404.
 * `?size=letter|a4`; `?download=1` lo entrega como descarga en vez de abrirlo en el visor.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/v1/tenants/[tenantId]/quotes/[quoteId]/pdf">,
) {
  const { tenantId, quoteId } = await context.params;
  if (!(await getOptionalUser())) return new Response(null, { status: 401 });

  const url = new URL(request.url);
  const paper = paperFrom(url.searchParams.get("size"));
  if (paper === null) return new Response("Tamaño de hoja no válido.", { status: 400 });

  const active = await requireActiveTenant(tenantId);
  const result = await loadQuoteDocumentData(active, quoteId, paper);
  if (!result.ok) {
    if (result.reason === "not_found") notFound();
    return new Response("No pudimos generar el PDF.", { status: 500 });
  }

  let pdf: Buffer;
  try {
    pdf = await renderQuotePdf(result.data);
  } catch {
    await serverLog("error", "quote_pdf_render_failed");
    return new Response("No pudimos generar el PDF.", { status: 500 });
  }

  const fileName = quotePdfFileName(result.numberDisplay, result.version);
  const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
