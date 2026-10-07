import { ClipboardList, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CopyLinkButton } from "@/components/intake/copy-link-button";
import { FormStatusBadge } from "@/components/intake/form-status-badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FORMS_PER_ORGANIZATION_MAX } from "@/lib/intake/builder-model";
import { loadFormList } from "@/lib/intake/builder-queries";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Formularios · Cotiza Prime" };

function requestsLabel(count: number, lowerBound: boolean): string {
  // Si la lectura llegó al tope, son «al menos» esas: no se afirma un número exacto.
  if (lowerBound) return count === 0 ? "Hay muchas solicitudes" : `Al menos ${count} solicitudes`;
  if (count === 0) return "Sin solicitudes";
  return count === 1 ? "1 solicitud" : `${count} solicitudes`;
}

export default async function IntakeFormsPage({
  params,
  searchParams,
}: PageProps<"/o/[tenantId]/formularios">) {
  const active = await requireActiveTenant((await params).tenantId);
  const showArchived = (await searchParams).estado === "archivados";
  const canEdit = active.role === "owner" || active.role === "admin";
  const result = await loadFormList(active, showArchived);
  const base = tenantPath(active.tenantId, "formularios");
  const atLimit =
    result.ok && result.totalActive !== null && result.totalActive >= FORMS_PER_ORGANIZATION_MAX;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl md:text-2xl">Formularios</h1>
          <p className="text-fg-muted">
            Enlaces donde cualquiera te pide una cotización, con tu marca y sin ver precios.
          </p>
        </div>
        {canEdit ? (
          <div className="flex flex-col items-start gap-1.5 md:items-end">
            {atLimit ? (
              <span
                aria-disabled="true"
                data-testid="new-form"
                className={cn(buttonVariants(), "pointer-events-none opacity-50")}
              >
                <Plus aria-hidden />
                Crear formulario
              </span>
            ) : (
              <Link href={`${base}/nuevo`} className={cn(buttonVariants())} data-testid="new-form">
                <Plus aria-hidden />
                Crear formulario
              </Link>
            )}
            {result.ok && result.totalActive !== null ? (
              <p data-testid="forms-count" className="text-sm text-fg-muted">
                {result.totalActive} de {FORMS_PER_ORGANIZATION_MAX} formularios
                {atLimit ? ". Archiva alguno para crear otro." : ""}
              </p>
            ) : null}
          </div>
        ) : null}
      </header>

      {!result.ok ? (
        <p
          role="alert"
          className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm font-medium text-danger"
        >
          No pudimos cargar los formularios. Recarga la página en unos minutos.
        </p>
      ) : (
        <>
          <nav aria-label="Filtrar formularios" className="flex flex-wrap gap-2">
            {[
              { label: "Activos", href: base, selected: !showArchived },
              { label: "Archivados", href: `${base}?estado=archivados`, selected: showArchived },
            ].map((filter) => (
              <Link
                key={filter.label}
                href={filter.href}
                aria-current={filter.selected ? "true" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold md:min-h-9",
                  filter.selected
                    ? "border-accent bg-accent text-on-accent"
                    : "border-border-strong bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                {filter.label}
              </Link>
            ))}
          </nav>

          {result.rows.length === 0 ? (
            showArchived ? (
              <p className="rounded-lg border border-border bg-surface px-6 py-10 text-center text-fg-muted">
                No tienes formularios archivados.
              </p>
            ) : (
              <EmptyState
                icon={ClipboardList}
                title="Todavía no tienes formularios"
                description={
                  canEdit
                    ? "Un formulario público es un enlace donde alguien te pide una cotización: elige los servicios y deja sus datos, y la solicitud llega a tu equipo. Crea el primero."
                    : "Un formulario público es un enlace donde alguien pide una cotización a tu organización. Todavía no hay ninguno: el Dueño o un Administrador puede crearlo."
                }
              >
                {canEdit ? (
                  <Link href={`${base}/nuevo`} className={cn(buttonVariants())}>
                    <Plus aria-hidden />
                    Crear formulario
                  </Link>
                ) : null}
              </EmptyState>
            )
          ) : (
            <ul
              aria-label="Formularios de tu organización"
              className="grid gap-3 md:gap-0 md:divide-y md:divide-border md:overflow-hidden md:rounded-lg md:border md:border-border md:bg-surface md:shadow-1"
            >
              {result.rows.map((row) => (
                <li
                  key={row.id}
                  data-testid="intake-form-row"
                  className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:flex-row md:items-center md:justify-between md:gap-4 md:rounded-none md:border-0 md:shadow-none"
                >
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Link
                      href={`${base}/${row.id}`}
                      className="inline-flex min-h-11 items-center font-semibold break-words text-fg hover:text-accent hover:underline md:min-h-0"
                    >
                      {row.name}
                    </Link>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-fg-muted">
                      <FormStatusBadge status={row.status} />
                      {row.requestCount === null ? (
                        <span role="status" className="text-warning">
                          No pudimos contar las solicitudes. Recarga la página.
                        </span>
                      ) : (
                        <span>{requestsLabel(row.requestCount, row.requestCountIsLowerBound)}</span>
                      )}
                    </div>
                  </div>
                  {row.status === "published" && row.publicUrl ? (
                    <div className="flex min-w-0 flex-col gap-2 md:max-w-md md:items-end">
                      <p
                        data-testid="row-public-link"
                        className="min-w-0 rounded-sm bg-surface-2 px-3 py-1.5 font-mono text-xs break-all text-fg"
                      >
                        {row.publicUrl}
                      </p>
                      <CopyLinkButton url={row.publicUrl} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
