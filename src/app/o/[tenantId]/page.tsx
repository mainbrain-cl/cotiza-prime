import { Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { StatusSummary } from "@/components/app-shell/status-summary";
import { EmptyState } from "@/components/ui/empty-state";
import { FormAlert } from "@/components/ui/form-controls";
import { can } from "@/lib/permissions/matrix";
import { getQuoteSummary } from "@/lib/quotes/summary-query";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";

export const metadata: Metadata = { title: "Inicio · Cotiza Prime" };

export default async function TenantHomePage({ params }: PageProps<"/o/[tenantId]">) {
  const { tenantId } = await params;
  const active = await requireActiveTenant(tenantId);
  const summary = await getQuoteSummary(active);
  // El texto nombra solo lo que esta persona ve en su menú y puede hacer.
  const emptyDescription = can(active.role, "settings.manage")
    ? "Aquí verás lo que requiere tu atención. Para empezar, configura tu marca en Configuración, agrega los servicios de tu empresa al catálogo y después crea tu primera cotización."
    : can(active.role, "quote.create")
      ? "Aquí verás lo que requiere tu atención. Todavía no hay cotizaciones: crea la primera desde Cotizaciones."
      : "Aquí verás el resumen de las cotizaciones de tu organización cuando tu equipo empiece a cotizar.";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl md:text-2xl">Inicio</h1>
        <p className="text-fg-muted">{active.tenantName}</p>
      </header>
      {summary === null ? (
        <FormAlert>No pudimos cargar el resumen. Recarga la página en unos minutos.</FormAlert>
      ) : summary.total === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Tu organización está lista"
          description={emptyDescription}
        />
      ) : (
        <StatusSummary summary={summary} quotesPath={tenantPath(active.tenantId, "cotizaciones")} />
      )}
    </div>
  );
}
