import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadBrand } from "@/lib/brand/service";
import { logoUrl } from "@/lib/brand/logo";
import { loadCatalogChoices, loadForm } from "@/lib/intake/builder-queries";
import { isFormId } from "@/lib/intake/builder-schema";
import { buildConsentNotice } from "@/lib/intake/consent-notice";
import { resolvePdfBrand } from "@/lib/pdf/brand-colors";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { FormEditor } from "./form-editor";

export const metadata: Metadata = { title: "Formulario público · Cotiza Prime" };

export default async function IntakeFormEditorPage({
  params,
}: PageProps<"/o/[tenantId]/formularios/[formId]">) {
  const { tenantId, formId } = await params;
  const active = await requireActiveTenant(tenantId);
  if (!isFormId(formId)) notFound();

  const loaded = await loadForm(active, formId);
  if (!loaded) notFound();

  const canEdit = active.role === "owner" || active.role === "admin";
  const [brand, catalog, contact] = await Promise.all([
    loadBrand(active),
    canEdit ? loadCatalogChoices(active) : Promise.resolve([]),
    active.supabase
      .from("tenants")
      .select("contact_email")
      .eq("tenant_id", active.tenantId)
      .maybeSingle(),
  ]);
  const contactEmail = ((contact.data?.contact_email as string | null) ?? "").trim();
  const organizationName = brand?.name ?? active.tenantName;

  // El aviso de privacidad se arma en el servidor con la plantilla fija y los datos de la organización.
  let consentText: string | null = null;
  if (contactEmail !== "") {
    try {
      consentText = buildConsentNotice({ organizationName, contactEmail }).text;
    } catch {
      consentText = null;
    }
  }

  const listPath = tenantPath(active.tenantId, "formularios");
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href={listPath}
          className="inline-flex min-h-11 w-fit items-center gap-1 rounded-sm text-sm font-medium text-fg-muted outline-none hover:text-fg focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Formularios
        </Link>
        <h1 className="text-xl break-words md:text-2xl">{loaded.form.name}</h1>
        <p className="text-fg-muted">
          Arma lo que verá quien pida una cotización. Los precios nunca se muestran aquí.
        </p>
      </div>

      <FormEditor
        tenantId={active.tenantId}
        formId={loaded.id}
        canEdit={canEdit}
        initialRevision={loaded.revision}
        initialStatus={loaded.status}
        initialPublicUrl={loaded.publicUrl}
        initialForm={loaded.form}
        catalog={catalog}
        brand={resolvePdfBrand(brand?.primaryColor ?? null, brand?.secondaryColor ?? null)}
        organizationName={organizationName}
        logoSrc={logoUrl(active.tenantId, brand?.logoPath)}
        consentText={consentText}
        hasContactEmail={contactEmail !== ""}
        contactSettingsHref={tenantPath(active.tenantId, "configuracion/empresa")}
      />
    </div>
  );
}
