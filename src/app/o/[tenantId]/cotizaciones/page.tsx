import { FileText } from "lucide-react";
import type { Metadata } from "next";
import { ComingSoon } from "@/components/app-shell/coming-soon";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";

export const metadata: Metadata = { title: "Cotizaciones · Cotiza Prime" };

export default async function QuotesPage({ params }: PageProps<"/o/[tenantId]/cotizaciones">) {
  await requireActiveTenant((await params).tenantId);
  return (
    <ComingSoon
      title="Cotizaciones"
      icon={FileText}
      description="Aquí armarás, enviarás y seguirás tus cotizaciones. Todavía estamos construyendo esta parte."
    />
  );
}
