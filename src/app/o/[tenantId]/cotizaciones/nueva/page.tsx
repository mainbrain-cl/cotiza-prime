import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { listCustomers } from "@/lib/customers/queries";
import { toCustomerChoices } from "@/lib/quotes/customer-choice";
import { pagePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { CustomerPicker } from "./customer-picker";

export const metadata: Metadata = { title: "Nueva cotización · Cotiza Prime" };

export default async function NewQuotePage({
  params,
}: PageProps<"/o/[tenantId]/cotizaciones/nueva">) {
  const active = await requireActiveTenant((await params).tenantId);
  // Quien solo puede mirar no tiene nada que hacer aquí; antes de leer cualquier dato.
  const denied = pagePermission(active, "quote.create");
  if (denied) return denied;

  const page = await listCustomers(active, { page: 1 });
  const initial = toCustomerChoices(page?.items ?? []);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={tenantPath(active.tenantId, "cotizaciones")}
          className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold text-fg-muted hover:text-fg"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Cotizaciones
        </Link>
        <h1 className="text-xl md:text-2xl">Nueva cotización</h1>
        <p className="text-fg-muted">
          Primero elige a quién le cotizas. Al elegirlo se crea el borrador con su número y pasas a
          armar las líneas.
        </p>
      </header>
      <CustomerPicker tenantId={active.tenantId} initial={initial} />
    </div>
  );
}
