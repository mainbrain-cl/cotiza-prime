import { Tags } from "lucide-react";
import type { Metadata } from "next";
import { ComingSoon } from "@/components/app-shell/coming-soon";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";

export const metadata: Metadata = { title: "Catálogo · Cotiza Prime" };

export default async function CatalogPage({ params }: PageProps<"/o/[tenantId]/catalogo">) {
  await requireActiveTenant((await params).tenantId);
  return (
    <ComingSoon
      title="Catálogo"
      icon={Tags}
      description="Aquí tendrás tu lista de servicios y precios. Todavía estamos construyendo esta parte."
    />
  );
}
