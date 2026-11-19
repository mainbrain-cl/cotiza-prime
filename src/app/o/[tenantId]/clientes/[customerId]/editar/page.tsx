import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FormAlert } from "@/components/ui/form-controls";
import { formatRut } from "@/lib/chile/rut";
import { getCustomer } from "@/lib/customers/queries";
import { pagePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { CustomerForm } from "../../customer-form";

export const metadata: Metadata = { title: "Editar cliente · Cotiza Prime" };

export default async function EditCustomerPage({
  params,
}: PageProps<"/o/[tenantId]/clientes/[customerId]/editar">) {
  const { tenantId, customerId } = await params;
  const active = await requireActiveTenant(tenantId);
  // Quien solo puede mirar no tiene nada que hacer aquí; antes de leer al cliente.
  const denied = pagePermission(active, "customer.write");
  if (denied) return denied;
  const customer = await getCustomer(active, customerId);
  if (customer === null) notFound();
  const detailPath = tenantPath(active.tenantId, `clientes/${customerId}`);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={detailPath}
          className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold text-fg-muted hover:text-fg"
        >
          <ChevronLeft aria-hidden className="size-4" />
          {customer === "unreadable" ? "Cliente" : customer.displayName}
        </Link>
        <h1 className="text-xl md:text-2xl">Editar cliente</h1>
      </header>
      {customer === "unreadable" ? (
        <FormAlert tone="warning">
          No pudimos leer los datos de este cliente, así que no se puede editar. Avisa al equipo de
          soporte.
        </FormAlert>
      ) : (
        <section className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6">
          <CustomerForm
            tenantId={active.tenantId}
            customerId={customer.id}
            initial={{
              kind: customer.kind,
              displayName: customer.displayName,
              rut: customer.rut ? (formatRut(customer.rut) ?? customer.rut) : "",
              email: customer.email ?? "",
              phone: customer.phone ?? "",
              address: customer.address ?? "",
            }}
          />
        </section>
      )}
    </div>
  );
}
