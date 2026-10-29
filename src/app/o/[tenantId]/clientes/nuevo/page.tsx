import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { pagePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { CustomerForm } from "../customer-form";

export const metadata: Metadata = { title: "Nuevo cliente · Cotiza Prime" };

export default async function NewCustomerPage({
  params,
}: PageProps<"/o/[tenantId]/clientes/nuevo">) {
  const active = await requireActiveTenant((await params).tenantId);
  // Quien solo puede mirar no tiene nada que hacer aquí.
  const denied = pagePermission(active, "customer.write");
  if (denied) return denied;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={tenantPath(active.tenantId, "clientes")}
          className="inline-flex items-center gap-1 text-sm font-semibold text-fg-muted hover:text-fg"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Clientes
        </Link>
        <h1 className="text-xl md:text-2xl">Nuevo cliente</h1>
        <p className="text-fg-muted">
          Solo el nombre es obligatorio. Guarda lo que necesites para cotizarle.
        </p>
      </header>
      <section className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6">
        <CustomerForm tenantId={active.tenantId} />
      </section>
    </div>
  );
}
