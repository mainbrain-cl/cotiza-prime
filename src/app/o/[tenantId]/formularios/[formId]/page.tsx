import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { loadBrand } from "@/lib/brand/service";
import { logoUrl } from "@/lib/brand/logo";
import { loadCatalogChoices, loadForm } from "@/lib/intake/builder-queries";
import { isFormId } from "@/lib/intake/builder-schema";
import { buildConsentNotice } from "@/lib/intake/consent-notice";
import { loadProtection } from "@/lib/intake/protection-queries";
import { ProtectionSkeleton } from "@/components/intake/protection-panel";
import { resolvePdfBrand } from "@/lib/pdf/brand-colors";
import { can } from "@/lib/permissions/matrix";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { FormEditor } from "./form-editor";
import { ProtectionAlert, ProtectionSection } from "./protection-section";

export const metadata: Metadata = { title: "Formulario público · Cotiza Prime" };

export default async function IntakeFormEditorPage({
  params,
}: PageProps<"/o/[tenantId]/formularios/[formId]">) {
  const { tenantId, formId } = await params;
  const active = await requireActiveTenant(tenantId);
  if (!isFormId(formId)) notFound();

  // Los contadores (Dueño y Administrador; para los demás ni se consulta) parten junto con la lectura del formulario,
  // no después de las otras: así el aviso de tope llega con la página y no la empuja al aparecer. Una sola lectura
  // que usan el aviso y el panel, cada uno dentro de su <Suspense>.
  const protection = loadProtection(active);
  // Si el formulario no existe nadie espera esta promesa: que un fallo suyo no quede sin atender.
  protection.catch(() => undefined);
  const result = await loadForm(active, formId);
  if (!result.ok && result.reason === "not_found") notFound();
  if (!result.ok) {
    // La lectura falló: nunca se muestra un editor vacío (guardarlo borraría los servicios).
    return (
      <div className="flex flex-col gap-4">
        <Link
          href={tenantPath(active.tenantId, "formularios")}
          className="inline-flex min-h-11 w-fit items-center gap-1 rounded-sm text-sm font-medium text-fg-muted outline-none hover:text-fg focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Formularios
        </Link>
        <p
          role="alert"
          data-testid="form-load-error"
          className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm font-medium text-danger"
        >
          No pudimos cargar este formulario. Recarga la página en unos minutos.
        </p>
      </div>
    );
  }
  const loaded = result.loaded;

  const canEdit = can(active.role, "intake.forms.manage");
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

      <Suspense fallback={null}>
        <ProtectionAlert
          dataPromise={protection}
          formId={loaded.id}
          archived={loaded.status === "archived"}
        />
      </Suspense>

      <FormEditor
        tenantId={active.tenantId}
        formId={loaded.id}
        canEdit={canEdit}
        initialRevision={loaded.revision}
        initialStatus={loaded.status}
        initialPublicUrl={loaded.publicUrl}
        initialEmbedOrigins={canEdit ? loaded.embedOrigins : []}
        initialEmbedSnippet={canEdit ? loaded.embedSnippet : null}
        initialForm={loaded.form}
        catalog={catalog}
        brand={resolvePdfBrand(brand?.primaryColor ?? null, brand?.secondaryColor ?? null)}
        organizationName={organizationName}
        logoSrc={logoUrl(active.tenantId, brand?.logoPath)}
        consentText={consentText}
        hasContactEmail={contactEmail !== ""}
        contactSettingsHref={tenantPath(active.tenantId, "configuracion/empresa")}
        protectionSlot={
          canEdit ? (
            <Suspense fallback={<ProtectionSkeleton />}>
              <ProtectionSection
                dataPromise={protection}
                tenantId={active.tenantId}
                formId={loaded.id}
                dailyCap={loaded.dailyCap}
                archived={loaded.status === "archived"}
              />
            </Suspense>
          ) : null
        }
      />
    </div>
  );
}
