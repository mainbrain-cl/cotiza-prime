import { Users } from "lucide-react";
import type { Metadata } from "next";
import { ComingSoon } from "@/components/app-shell/coming-soon";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";

export const metadata: Metadata = { title: "Clientes · Cotiza Prime" };

export default async function CustomersPage({ params }: PageProps<"/o/[tenantId]/clientes">) {
  await requireActiveTenant((await params).tenantId);
  return (
    <ComingSoon
      title="Clientes"
      icon={Users}
      description="Aquí guardarás a quienes les cotizas, con su historial. Todavía estamos construyendo esta parte."
    />
  );
}
