import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { FormAlert } from "@/components/ui/form-controls";
import { DEFAULT_PRIMARY_COLOR, DEFAULT_SECONDARY_COLOR } from "@/lib/brand/colors";
import { logoUrl } from "@/lib/brand/logo";
import { loadBrand } from "@/lib/brand/service";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { BrandForm } from "./brand-form";

export const metadata: Metadata = { title: "Marca · Cotiza Prime" };

export default async function BrandPage({
  params,
}: PageProps<"/o/[tenantId]/configuracion/marca">) {
  const active = await requireActiveTenant((await params).tenantId);
  const canEdit = active.role === "owner" || active.role === "admin";
  const brand = await loadBrand(active);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href={tenantPath(active.tenantId, "configuracion")}
          className="inline-flex min-h-11 w-fit items-center gap-1 rounded-sm text-sm font-medium text-fg-muted outline-none hover:text-fg focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Configuración
        </Link>
        <h1 className="text-xl md:text-2xl">Tu marca</h1>
        <p className="text-fg-muted">
          Tu logo y tus colores aparecen en las cotizaciones y en lo que ve tu cliente.
        </p>
      </div>

      {brand ? (
        <BrandForm
          tenantId={active.tenantId}
          canEdit={canEdit}
          initial={{
            companyName: brand.name,
            primaryColor: brand.primaryColor ?? DEFAULT_PRIMARY_COLOR,
            secondaryColor: brand.secondaryColor ?? DEFAULT_SECONDARY_COLOR,
            logoUrl: logoUrl(active.tenantId, brand.logoPath),
          }}
        />
      ) : (
        <FormAlert>
          No pudimos cargar tu marca. Recarga la página; si sigue igual, intenta en unos minutos.
        </FormAlert>
      )}
    </div>
  );
}
