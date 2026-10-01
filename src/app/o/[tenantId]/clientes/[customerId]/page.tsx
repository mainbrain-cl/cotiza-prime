import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FormAlert } from "@/components/ui/form-controls";
import { formatRut } from "@/lib/chile/rut";
import { getCustomer } from "@/lib/customers/queries";
import { CUSTOMER_KINDS } from "@/lib/customers/schemas";
import { formatDate } from "@/lib/format-date";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";

export const metadata: Metadata = { title: "Cliente · Cotiza Prime" };

const EMPTY = "Sin registrar";

export default async function CustomerDetailPage({
  params,
  searchParams,
}: PageProps<"/o/[tenantId]/clientes/[customerId]">) {
  const { tenantId, customerId } = await params;
  const active = await requireActiveTenant(tenantId);
  const customer = await getCustomer(active, customerId);
  if (customer === null) notFound();
  const justCreated = (await searchParams).creado === "1";
  const listPath = tenantPath(active.tenantId, "clientes");

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={listPath}
          className="inline-flex items-center gap-1 text-sm font-semibold text-fg-muted hover:text-fg"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Clientes
        </Link>
        {customer === "unreadable" ? (
          <h1 className="text-xl md:text-2xl">Cliente</h1>
        ) : (
          <h1 className="text-xl md:text-2xl">{customer.displayName}</h1>
        )}
      </header>

      {justCreated ? <FormAlert tone="success">Cliente guardado.</FormAlert> : null}

      {customer === "unreadable" ? (
        <FormAlert tone="warning">
          No pudimos mostrar los datos de este cliente. Avisa al equipo de soporte.
        </FormAlert>
      ) : (
        <section className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6">
          <dl className="grid gap-x-8 gap-y-5 md:grid-cols-2">
            <Item label="Tipo">
              {CUSTOMER_KINDS.find((kind) => kind.value === customer.kind)?.label}
            </Item>
            <Item label="RUT">
              {customer.rut ? (formatRut(customer.rut) ?? customer.rut) : EMPTY}
            </Item>
            <Item label="Correo">{customer.email ?? EMPTY}</Item>
            <Item label="Teléfono">{customer.phone ?? EMPTY}</Item>
            <Item label="Dirección" wide>
              {customer.address ?? EMPTY}
            </Item>
            <Item label="Registrado el">{formatDate(customer.createdAt)}</Item>
          </dl>
        </section>
      )}
    </div>
  );
}

function Item({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={wide ? "flex flex-col gap-1 md:col-span-2" : "flex flex-col gap-1"}>
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="font-medium break-words text-fg">{children}</dd>
    </div>
  );
}
