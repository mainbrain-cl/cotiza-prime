import "server-only";
import { LOGO_BUCKET, loadBrand } from "@/lib/brand/service";
import { mimeForLogoPath } from "@/lib/brand/logo";
import { getCustomer } from "@/lib/customers/queries";
import type { CustomerView } from "@/lib/customers/record";
import { getQuote } from "@/lib/quotes/queries";
import { todayInChile } from "@/lib/quotes/validity";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { logoForPdf } from "./logo-image";
import { buildQuoteDocumentData } from "./quote-document-model";
import type { PdfLogo, PdfPaperSize, QuoteDocumentData } from "./types";

export type QuoteDocumentResult =
  | {
      ok: true;
      data: QuoteDocumentData;
      numberDisplay: string;
      version: number;
      revision: number;
      /** Quién lo recibe, descifrado en el servidor (para el correo y la copia congelada del envío). */
      customer: CustomerView;
      organizationName: string;
      organizationContactEmail: string | null;
    }
  | { ok: false; reason: "not_found" | "failed" };

/** Fechas que se congelan al enviar: la de emisión y la vigencia ya calculada por la base de datos. */
export type FrozenDocumentDates = { issueDate: string; validUntil: string };

/**
 * ÚNICO lugar que junta lo guardado de una cotización para el PDF: la cotización y sus líneas (con la
 * organización activa: lo ajeno no existe), la marca y el logo de la organización, y el cliente
 * descifrado en el servidor. Los datos personales no salen de aquí hacia ningún otro lado.
 *
 * En la vista previa la fecha de emisión es hoy. Al enviar (H-029) se pasa `frozen`: la fecha de
 * emisión y la vigencia que la base de datos congeló con el paquete.
 */
export async function loadQuoteDocumentData(
  active: ActiveTenant,
  quoteId: string,
  paper: PdfPaperSize,
  frozen?: FrozenDocumentDates,
  /** Cliente ya leído por quien llama (el envío): el PDF y la copia congelada usan el mismo dato. */
  preloadedCustomer?: CustomerView,
): Promise<QuoteDocumentResult> {
  const detail = await getQuote(active, quoteId);
  if (detail === null) return { ok: false, reason: "not_found" };
  const { quote, items, authorName } = detail;

  const [customer, brand, tenantRow] = await Promise.all([
    preloadedCustomer ?? getCustomer(active, quote.customer_id),
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
    revision: quote.revision,
    customer,
    organizationName: brand.name,
    organizationContactEmail: row.contact_email,
    data: buildQuoteDocumentData({
      paper,
      today: frozen?.issueDate ?? todayInChile(),
      quote: frozen ? { ...quote, validity_mode: "date", valid_until: frozen.validUntil } : quote,
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
