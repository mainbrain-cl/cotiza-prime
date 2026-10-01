import { Settings } from "lucide-react";
import type { Metadata } from "next";
import { ComingSoon } from "@/components/app-shell/coming-soon";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";

export const metadata: Metadata = { title: "Configuración · Cotiza Prime" };

export default async function SettingsPage({ params }: PageProps<"/o/[tenantId]/configuracion">) {
  await requireActiveTenant((await params).tenantId);
  return (
    <ComingSoon
      title="Configuración"
      icon={Settings}
      description="Aquí ajustarás los datos de tu empresa, tu marca, tu equipo y tus reglas. Todavía estamos construyendo esta parte."
    />
  );
}
