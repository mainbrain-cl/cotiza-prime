import { Plus, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormAlert } from "@/components/ui/form-controls";
import { maskEmail, maskPhone, maskRut } from "@/lib/customers/mask";
import { listCustomers } from "@/lib/customers/queries";
import { CUSTOMER_KINDS } from "@/lib/customers/schemas";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";

export const metadata: Metadata = { title: "Clientes · Cotiza Prime" };

const KIND_LABEL: Record<string, string> = Object.fromEntries(
  CUSTOMER_KINDS.map((kind) => [kind.value, kind.label]),
);
const EMPTY = "—";
const WRITER_ROLES = ["owner", "admin", "sales"];

export default async function CustomersPage({ params }: PageProps<"/o/[tenantId]/clientes">) {
  const active = await requireActiveTenant((await params).tenantId);
  const items = await listCustomers(active);
  const canCreate = WRITER_ROLES.includes(active.role);
  const newPath = tenantPath(active.tenantId, "clientes/nuevo");

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl md:text-2xl">Clientes</h1>
          <p className="text-fg-muted">
            A quienes les cotizas, para no volver a escribir sus datos.
          </p>
        </div>
        {canCreate ? (
          <Link href={newPath} className={buttonVariants({ size: "default" })}>
            <Plus aria-hidden />
            Nuevo cliente
          </Link>
        ) : null}
      </header>

      {items === null ? (
        <FormAlert>No pudimos cargar tus clientes. Recarga la página en unos minutos.</FormAlert>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Aún no tienes clientes"
          description="Registra a tu primer cliente para poder cotizarle más adelante."
        >
          {canCreate ? (
            <Link href={newPath} className={buttonVariants({ size: "lg" })}>
              Registrar un cliente
            </Link>
          ) : null}
        </EmptyState>
      ) : (
        <>
          {/* Teléfono: tarjetas */}
          <ul className="flex flex-col gap-3 md:hidden" data-testid="customer-cards">
            {items.map((item) => {
              const href = tenantPath(
                active.tenantId,
                `clientes/${item.ok ? item.customer.id : item.id}`,
              );
              const name = item.ok ? item.customer.displayName : item.displayName;
              return (
                <li key={item.ok ? item.customer.id : item.id}>
                  <Link
                    href={href}
                    className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4 shadow-1 transition-transform duration-(--dur-fast) ease-ios active:scale-[0.99]"
                  >
                    <span className="font-semibold text-fg">{name}</span>
                    {item.ok ? (
                      <>
                        <span className="text-sm text-fg-muted">
                          {KIND_LABEL[item.customer.kind]}
                          {item.customer.rut ? ` · ${maskRut(item.customer.rut)}` : ""}
                        </span>
                        {item.customer.email ? (
                          <span className="text-sm text-fg-muted">
                            {maskEmail(item.customer.email)}
                          </span>
                        ) : null}
                        {item.customer.phone ? (
                          <span className="text-sm text-fg-muted">
                            {maskPhone(item.customer.phone)}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-sm text-warning">No pudimos mostrar sus datos.</span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>

          {/* Escritorio: tabla */}
          <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface shadow-1 md:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-fg-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Nombre
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Tipo
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    RUT
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Correo
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Teléfono
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((item) => {
                  const id = item.ok ? item.customer.id : item.id;
                  const name = item.ok ? item.customer.displayName : item.displayName;
                  return (
                    <tr key={id} className="hover:bg-surface-2">
                      <td className="px-4 py-3">
                        <Link
                          href={tenantPath(active.tenantId, `clientes/${id}`)}
                          className="font-semibold text-accent underline-offset-4 hover:underline"
                        >
                          {name}
                        </Link>
                      </td>
                      {item.ok ? (
                        <>
                          <td className="px-4 py-3">{KIND_LABEL[item.customer.kind]}</td>
                          <td className="px-4 py-3 tabular-nums">
                            {item.customer.rut ? maskRut(item.customer.rut) : EMPTY}
                          </td>
                          <td className="px-4 py-3">
                            {item.customer.email ? maskEmail(item.customer.email) : EMPTY}
                          </td>
                          <td className="px-4 py-3 tabular-nums">
                            {item.customer.phone ? maskPhone(item.customer.phone) : EMPTY}
                          </td>
                        </>
                      ) : (
                        <td colSpan={4} className="px-4 py-3 text-warning">
                          No pudimos mostrar sus datos.
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
