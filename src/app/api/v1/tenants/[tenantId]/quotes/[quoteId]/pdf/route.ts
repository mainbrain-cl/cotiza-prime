import { notFound } from "next/navigation";
import { getOptionalUser } from "@/lib/auth/session";
import { consumePdfQuota, PDF_LOCK_SECONDS } from "@/lib/security/login-rate-limit";
import { pdfCache, pdfCacheKey } from "@/lib/pdf/cache";
import { serverLog } from "@/lib/log/server-log";
import { quotePdfFileName } from "@/lib/pdf/file-name";
import { loadQuoteDocumentData } from "@/lib/pdf/quote-document-data";
import { renderQuotePdf } from "@/lib/pdf/render";
import { PDF_PAPER_SIZES, type PdfPaperSize } from "@/lib/pdf/types";
import { readPackagePdf } from "@/lib/quotes/send/document-storage";
import { requireActiveTenant, type ActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid } from "@/lib/tenant/constants";

export const runtime = "nodejs";

const DEFAULT_PAPER: PdfPaperSize = "letter";

function paperFrom(value: string | null): PdfPaperSize | null {
  if (value === null) return DEFAULT_PAPER;
  return (PDF_PAPER_SIZES as readonly string[]).includes(value) ? (value as PdfPaperSize) : null;
}

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

type FrozenPdf = { bytes: Uint8Array; fileName: string };

/**
 * Una cotización que ya se envió se entrega SIEMPRE desde el archivo congelado (H-029): volver a
 * armarla daría otra fecha de emisión y otro archivo. `null` si la cotización sigue en borrador (o
 * nunca llegó a enviarse); `"missing"` si el archivo congelado no está o no coincide con su sello.
 */
async function frozenPdfFor(
  active: ActiveTenant,
  quoteId: string,
): Promise<FrozenPdf | "missing" | null> {
  if (!isUuid(quoteId)) return null;
  const { data: quote } = await active.supabase
    .from("quotes")
    .select("current_package_id, number_display, version")
    .eq("tenant_id", active.tenantId)
    .eq("id", quoteId)
    .maybeSingle();
  const row = quote as {
    current_package_id: string | null;
    number_display: string;
    version: number;
  } | null;
  if (!row?.current_package_id) return null;
  const { data: pkg } = await active.supabase
    .from("quote_packages")
    .select("pdf_path, pdf_sha256")
    .eq("tenant_id", active.tenantId)
    .eq("id", row.current_package_id)
    .eq("state", "sent")
    .maybeSingle();
  const stored = pkg as { pdf_path: string | null; pdf_sha256: string | null } | null;
  if (!stored?.pdf_path || !stored.pdf_sha256) return "missing";
  // Una ruta guardada que no es de esta organización se trata como archivo faltante, nunca se lee.
  const bytes = await readPackagePdf(active.tenantId, stored.pdf_path, stored.pdf_sha256).catch(
    () => null,
  );
  if (bytes === null) return "missing";
  return { bytes, fileName: quotePdfFileName(row.number_display, row.version) };
}

/**
 * PDF de una cotización (H-028), generado en el servidor con lo guardado. Solo para miembros de la
 * organización: quien no lo es, o una cotización que no existe en ella, recibe el mismo 404.
 * `?size=letter|a4`; `?download=1` lo entrega como descarga en vez de abrirlo en el visor.
 * Si la cotización ya fue enviada, entrega el archivo congelado tal cual (ignora `size`).
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/v1/tenants/[tenantId]/quotes/[quoteId]/pdf">,
) {
  const { tenantId, quoteId } = await context.params;
  const user = await getOptionalUser();
  if (!user) return new Response(null, { status: 401 });

  const url = new URL(request.url);
  const paper = paperFrom(url.searchParams.get("size"));
  if (paper === null) return new Response("Tamaño de hoja no válido.", { status: 400 });

  const active = await requireActiveTenant(tenantId);
  const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
  const frozen = await frozenPdfFor(active, quoteId);
  if (frozen === "missing") {
    await serverLog("error", "quote_frozen_pdf_missing");
    return new Response("No pudimos obtener el PDF.", { status: 500 });
  }
  if (frozen) {
    return new Response(new Uint8Array(frozen.bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${disposition}; filename="${frozen.fileName}"`,
        ...NO_STORE_HEADERS,
      },
    });
  }
  const result = await loadQuoteDocumentData(active, quoteId, paper);
  if (!result.ok) {
    if (result.reason === "not_found") notFound();
    return new Response("No pudimos generar el PDF.", { status: 500 });
  }

  // Armar un PDF grande es costoso: si nada cambió, se entrega el ya armado (la clave lleva la
  // organización y una huella del contenido); y los PDF que sí se arman tienen tope por persona y
  // por organización.
  const cacheKey = pdfCacheKey({
    tenantId: active.tenantId,
    quoteId,
    revision: result.revision,
    paper,
    data: result.data,
  });
  let pdf: Buffer;
  try {
    const built = await pdfCache.getOrRender(
      cacheKey,
      () => consumePdfQuota(user.id, active.tenantId),
      () => renderQuotePdf(result.data),
    );
    if (!built.ok) {
      return new Response(
        "Pediste muchos PDF en poco tiempo. Espera un minuto e inténtalo de nuevo.",
        {
          status: 429,
          headers: { "Retry-After": String(PDF_LOCK_SECONDS), "Cache-Control": "no-store" },
        },
      );
    }
    pdf = built.pdf;
  } catch {
    await serverLog("error", "quote_pdf_render_failed");
    return new Response("No pudimos generar el PDF.", { status: 500 });
  }

  const fileName = quotePdfFileName(result.numberDisplay, result.version);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${fileName}"`,
      ...NO_STORE_HEADERS,
    },
  });
}
