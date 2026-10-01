import { Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/empty-state";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";

export const metadata: Metadata = { title: "Inicio · Cotiza Prime" };

export default async function TenantHomePage({ params }: PageProps<"/o/[tenantId]">) {
  const { tenantId } = await params;
  const active = await requireActiveTenant(tenantId);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl md:text-2xl">Inicio</h1>
        <p className="text-fg-muted">{active.tenantName}</p>
      </header>
      <EmptyState
        icon={Sparkles}
        title="Tu organización está lista"
        description="Aquí verás lo que requiere tu atención. Para empezar, configura la marca y los servicios de tu empresa y después crea tu primera cotización. Estos pasos estarán disponibles pronto."
      />
    </div>
  );
}
