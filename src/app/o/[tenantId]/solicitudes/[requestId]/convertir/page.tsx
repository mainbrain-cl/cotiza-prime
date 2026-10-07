import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ConvertRequestForm } from "@/components/intake/convert-request-form";
import { FormAlert } from "@/components/ui/form-controls";
import { CUSTOMER_ADDRESS_MAX_LENGTH } from "@/lib/customers/schemas";
import {
  CONVERT_ANONYMIZED,
  CONVERT_DISCARDED,
  CONVERT_FORBIDDEN,
} from "@/lib/intake/convert-model";
import { findRequestCustomerDuplicates } from "@/lib/intake/convert-queries";
import { requestPermissions, formatRequestQuantity } from "@/lib/intake/requests-model";
import { loadRequest } from "@/lib/intake/requests-queries";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";

export const metadata: Metadata = { title: "Crear cotización desde una solicitud · Cotiza Prime" };

const WRITER_ROLES = ["owner", "admin", "sales"];

export default async function ConvertRequestPage({
  params,
}: PageProps<"/o/[tenantId]/solicitudes/[requestId]/convertir">) {
  const { tenantId, requestId } = await params;
  const active = await requireActiveTenant(tenantId);
  // Quien solo puede mirar no tiene nada que hacer aquí.
  if (!WRITER_ROLES.includes(active.role)) notFound();
  const result = await loadRequest(active, requestId);
  if (!result.ok && result.reason === "not_found") notFound();

  const requestPath = tenantPath(active.tenantId, `solicitudes/${requestId}`);
  const back = (
    <Link
      href={requestPath}
      className="inline-flex min-h-11 w-fit items-center gap-1 rounded-sm text-sm font-medium text-fg-muted outline-none hover:text-fg focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      <ChevronLeft aria-hidden className="size-4" />
      Volver a la solicitud
    </Link>
  );
  if (!result.ok) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <FormAlert>No pudimos cargar esta solicitud. Recarga la página en unos minutos.</FormAlert>
      </div>
    );
  }
  const request = result.detail;
  // Ya convertida: se lleva a su cotización.
  if (request.status === "converted" && request.quoteId) {
    redirect(tenantPath(active.tenantId, `cotizaciones/${request.quoteId}`));
  }
  const permissions = requestPermissions(active.role, active.userId, {
    status: request.status,
    assignedTo: request.assignedToId,
    anonymized: request.anonymized,
  });
  if (!permissions.canConvert) {
    const reason = request.anonymized
      ? CONVERT_ANONYMIZED
      : request.status === "discarded"
        ? CONVERT_DISCARDED
        : CONVERT_FORBIDDEN;
    return (
      <div className="flex flex-col gap-4">
        {back}
        <h1 className="text-xl md:text-2xl">No se puede crear la cotización</h1>
        <p role="alert" data-testid="convert-blocked" className="text-fg-muted">
          {reason}
        </p>
      </div>
    );
  }

  const { contact } = request;
  const duplicates = await findRequestCustomerDuplicates(active, contact.email);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        {back}
        <h1 className="text-xl md:text-2xl">Crear cotización desde la solicitud</h1>
        <p className="text-fg-muted">
          Revisa los datos del cliente. Al confirmar se crea el borrador con su número y los
          servicios del catálogo que pidió; después ajustas y envías como siempre.
        </p>
      </header>

      <section
        aria-label="Lo que pidió"
        className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
      >
        <h2 className="text-lg">Lo que pidió</h2>
        {request.items.length === 0 ? (
          <p className="text-fg-muted">No eligió servicios.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm">
            {request.items.map((item, index) => (
              <li key={`${item.name}-${index}`} className="flex flex-wrap justify-between gap-x-4">
                <span className="font-medium break-words">{item.name}</span>
                <span className="text-fg-muted">{formatRequestQuantity(item)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-fg-muted">
          Su mensaje no se copia a la cotización: lo verás aparte, como «Solicitud original», solo
          para tu equipo.
        </p>
      </section>

      <ConvertRequestForm
        tenantId={active.tenantId}
        requestId={request.id}
        requestPath={requestPath}
        initial={{
          name: contact.name ?? "",
          email: contact.email ?? "",
          phone: contact.phone ?? "",
          company: contact.company ?? "",
          address: [contact.serviceAddress, contact.comuna]
            .filter(Boolean)
            .join(", ")
            .slice(0, CUSTOMER_ADDRESS_MAX_LENGTH),
        }}
        duplicates={duplicates}
      />
    </div>
  );
}
