import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { FormAlert } from "@/components/ui/form-controls";
import { can } from "@/lib/permissions/matrix";
import { pagePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { formatRut } from "@/lib/rut";
import { CompanyForm } from "./company-form";

export const metadata: Metadata = { title: "Empresa · Cotiza Prime" };

export default async function CompanyPage({
  params,
}: PageProps<"/o/[tenantId]/configuracion/empresa">) {
  const active = await requireActiveTenant((await params).tenantId);
  // Solo quien maneja la organización (supuesto 12): los demás roles no ven «Configuración».
  const denied = pagePermission(active, "settings.manage");
  if (denied) return denied;
  const canEdit = can(active.role, "settings.manage");

  const { data, error } = await active.supabase
    .from("tenants")
    .select("name, rut, industry, contact_email, contact_phone, default_validity_days")
    .eq("tenant_id", active.tenantId)
    .maybeSingle();

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
        <h1 className="text-xl md:text-2xl">Tu empresa</h1>
        <p className="text-fg-muted">
          Los datos con que tus clientes te reconocen. Aparecen en tus cotizaciones.
        </p>
      </div>

      {error || !data ? (
        <FormAlert>
          No pudimos cargar los datos de tu empresa. Recarga la página; si sigue igual, intenta en
          unos minutos.
        </FormAlert>
      ) : (
        <CompanyForm
          tenantId={active.tenantId}
          canEdit={canEdit}
          initial={{
            name: data.name as string,
            rut: formatRut((data.rut as string | null) ?? ""),
            industry: (data.industry as string | null) ?? "",
            contactEmail: (data.contact_email as string | null) ?? "",
            contactPhone: (data.contact_phone as string | null) ?? "",
            defaultValidityDays: String(data.default_validity_days ?? 15),
          }}
        />
      )}
    </div>
  );
}
