import { ChevronRight, Hash } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";

export const metadata: Metadata = { title: "Configuración · Cotiza Prime" };

const UPCOMING = [
  "Tu empresa y tu marca",
  "Tu equipo",
  "Cómo te pagan",
  "Tus reglas de aprobación",
];

export default async function SettingsPage({ params }: PageProps<"/o/[tenantId]/configuracion">) {
  const active = await requireActiveTenant((await params).tenantId);
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl md:text-2xl">Configuración</h1>
        <p className="text-fg-muted">Ajusta cómo funciona tu organización.</p>
      </div>

      <ul className="flex flex-col gap-3">
        <li>
          <Link
            href={tenantPath(active.tenantId, "configuracion/numeracion")}
            className="flex min-h-11 items-center gap-4 rounded-lg border border-border bg-surface px-4 py-4 shadow-1 transition-[border-color,box-shadow] duration-(--dur-fast) ease-ios outline-none hover:border-accent focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
              <Hash aria-hidden strokeWidth={1.75} className="size-5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold text-fg">Numeración</span>
              <span className="text-sm text-fg-muted">
                Prefijo, formato y desde qué número parten tus cotizaciones.
              </span>
            </span>
            <ChevronRight aria-hidden className="size-5 shrink-0 text-fg-subtle" />
          </Link>
        </li>
        {UPCOMING.map((title) => (
          <li
            key={title}
            className="flex min-h-11 items-center justify-between gap-4 rounded-lg border border-dashed border-border px-4 py-3 text-fg-muted"
          >
            <span>{title}</span>
            <span className="text-sm">Disponible pronto</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
