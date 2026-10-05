import "server-only";
import { LOGO_BUCKET, loadBrand } from "@/lib/brand/service";
import { mimeForLogoPath } from "@/lib/brand/logo";
import { getCustomer } from "@/lib/customers/queries";
import { getQuote } from "@/lib/quotes/queries";
import { todayInChile } from "@/lib/quotes/validity";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { logoForPdf } from "./logo-image";
import { buildQuoteDocumentData } from "./quote-document-model";
import type { PdfLogo, PdfPaperSize, QuoteDocumentData } from "./types";

export type QuoteDocumentResult =
  | { ok: true; data: QuoteDocumentData; numberDisplay: string; version: number }
  | { ok: false; reason: "not_found" | "failed" };

/**
 * ÚNICO lugar que junta lo guardado de una cotización para el PDF: la cotización y sus líneas (con la
 * organización activa: lo ajeno no existe), la marca y el logo de la organización, y el cliente
 * descifrado en el servidor. Los datos personales no salen de aquí hacia ningún otro lado.
 */
export async function loadQuoteDocumentData(
  active: ActiveTenant,
  quoteId: string,
  paper: PdfPaperSize,
): Promise<QuoteDocumentResult> {
  const detail = await getQuote(active, quoteId);
  if (detail === null) return { ok: false, reason: "not_found" };
  const { quote, items, authorName } = detail;

  const [customer, brand, tenantRow] = await Promise.all([
    getCustomer(active, quote.customer_id),
    loadBrand(active),
    active.supabase
      .from("tenants")
      .select("rut, industry, contact_email, contact_phone")
      .eq("tenant_id", active.tenantId)
      .maybeSingle(),
  ]);
  if (customer === null || customer === "unreadable" || brand === null || !tenantRow.data) {
    return { ok: false, reason: "failed" };
  }

  let logo: PdfLogo | null = null;
  if (brand.logoPath && mimeForLogoPath(brand.logoPath)) {
    const { data: file } = await active.supabase.storage.from(LOGO_BUCKET).download(brand.logoPath);
    if (file) logo = await logoForPdf(new Uint8Array(await file.arrayBuffer()));
  }

  const row = tenantRow.data as {
    rut: string | null;
    industry: string | null;
    contact_email: string | null;
    contact_phone: string | null;
  };
  return {
    ok: true,
    numberDisplay: quote.number_display,
    version: quote.version,
    data: buildQuoteDocumentData({
      paper,
      today: todayInChile(),
      quote,
      items,
      authorName,
      organization: {
        name: brand.name,
        rut: row.rut,
        industry: row.industry,
        contactEmail: row.contact_email,
        contactPhone: row.contact_phone,
        primaryColor: brand.primaryColor,
        secondaryColor: brand.secondaryColor,
        logo,
      },
      customer: {
        displayName: customer.displayName,
        rut: customer.rut,
        email: customer.email,
        phone: customer.phone,
        address: customer.address,
      },
    }),
  };
}
