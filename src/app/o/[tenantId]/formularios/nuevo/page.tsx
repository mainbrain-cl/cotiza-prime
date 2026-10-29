import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { pagePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { CreateIntakeForm } from "./create-form";

export const metadata: Metadata = { title: "Nuevo formulario · Cotiza Prime" };

export default async function NewIntakeFormPage({
  params,
}: PageProps<"/o/[tenantId]/formularios/nuevo">) {
  const active = await requireActiveTenant((await params).tenantId);
  // Crear formularios es de quien maneja la organización; antes de leer cualquier dato.
  const denied = pagePermission(active, "intake.forms.manage");
  if (denied) return denied;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={tenantPath(active.tenantId, "formularios")}
          className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold text-fg-muted hover:text-fg"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Formularios
        </Link>
        <h1 className="text-xl md:text-2xl">Nuevo formulario</h1>
        <p className="text-fg-muted">
          Parte con un nombre. En el siguiente paso eliges qué datos pides y qué servicios se pueden
          pedir.
        </p>
      </header>
      <section className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6">
        <CreateIntakeForm tenantId={active.tenantId} />
      </section>
    </div>
  );
}
