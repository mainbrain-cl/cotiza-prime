import { Inbox } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { RequestStatusBadge } from "@/components/intake/request-status-badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDateTime } from "@/lib/format-date";
import { loadRequestList } from "@/lib/intake/requests-queries";
import {
  DATA_DELETED_LABEL,
  REQUEST_FILTERS,
  REQUEST_LIST_LIMIT,
  parseRequestFilter,
  timeSince,
  type RequestFilter,
} from "@/lib/intake/requests-model";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Solicitudes · Cotiza Prime" };

const EMPTY_TEXT: Record<RequestFilter, { title: string; description: string }> = {
  todas: {
    title: "Todavía no llegan solicitudes",
    description:
      "Cuando alguien pida una cotización por tu formulario público, aparecerá aquí para que tu equipo la atienda.",
  },
  "sin-asignar": {
    title: "No hay solicitudes sin asignar",
    description: "Todas las solicitudes que llegaron ya tienen a alguien a cargo.",
  },
  mias: {
    title: "No tienes solicitudes asignadas",
    description: "Cuando te asignen una, la verás aquí.",
  },
  convertidas: {
    title: "Aún no hay solicitudes convertidas",
    description: "Aquí quedan las solicitudes que ya se transformaron en cotización.",
  },
  descartadas: {
    title: "No hay solicitudes descartadas",
    description: "Las que descartes (spam, duplicadas) quedan aquí unos días antes de borrarse.",
  },
};

export default async function RequestsPage({
  params,
  searchParams,
}: PageProps<"/o/[tenantId]/solicitudes">) {
  const active = await requireActiveTenant((await params).tenantId);
  const filter = parseRequestFilter((await searchParams).estado);
  const result = await loadRequestList(active, filter);
  const base = tenantPath(active.tenantId, "solicitudes");

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl md:text-2xl">Solicitudes</h1>
        <p className="text-fg-muted">
          Lo que piden tus clientes por el formulario público, para que tu equipo lo atienda.
        </p>
      </header>

      <nav aria-label="Filtrar solicitudes" className="flex flex-wrap gap-2">
        {REQUEST_FILTERS.map((option) => {
          const selected = option.value === filter;
          return (
            <Link
              key={option.value}
              href={option.value === "todas" ? base : `${base}?estado=${option.value}`}
              aria-current={selected ? "true" : undefined}
              data-testid={`filter-${option.value}`}
              className={cn(
                "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold md:min-h-9",
                selected
                  ? "border-accent bg-accent text-on-accent"
                  : "border-border-strong bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              {option.label}
            </Link>
          );
        })}
      </nav>

      {!result.ok ? (
        <p
          role="alert"
          data-testid="requests-error"
          className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm font-medium text-danger"
        >
          No pudimos cargar las solicitudes. Recarga la página en unos minutos.
        </p>
      ) : result.rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={EMPTY_TEXT[filter].title}
          description={EMPTY_TEXT[filter].description}
        >
          {filter === "todas" ? (
            <Link
              href={tenantPath(active.tenantId, "formularios")}
              className={cn(buttonVariants())}
            >
              Ver mis formularios
            </Link>
          ) : null}
        </EmptyState>
      ) : (
        <>
          <ul
            aria-label="Solicitudes de tu organización"
            data-testid="requests-list"
            className="grid gap-3 md:gap-0 md:divide-y md:divide-border md:overflow-hidden md:rounded-lg md:border md:border-border md:bg-surface md:shadow-1"
          >
            {result.rows.map((row) => {
              const open = row.status === "new" || row.status === "assigned";
              return (
                <li
                  key={row.id}
                  data-testid="request-row"
                  data-status={row.status}
                  className={cn(
                    "relative flex min-w-0 flex-col gap-2 rounded-lg border bg-surface p-4 shadow-1 md:gap-1.5 md:rounded-none md:border-0 md:shadow-none",
                    row.status === "new" ? "border-warning" : "border-border",
                    row.status === "new" && "md:bg-warning-soft/40",
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`${base}/${row.id}`}
                      data-testid="request-link"
                      className="inline-flex min-h-11 min-w-0 items-center font-semibold break-words text-fg after:absolute after:inset-0 hover:text-accent hover:underline md:min-h-0"
                    >
                      {row.anonymized
                        ? DATA_DELETED_LABEL
                        : (row.contactName ?? "No pudimos leer el nombre")}
                    </Link>
                    <RequestStatusBadge status={row.status} />
                  </div>
                  <p className="text-sm break-words text-fg-muted">{row.itemsSummary}</p>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
                    <span title={formatDateTime(row.createdAt)}>{timeSince(row.createdAt)}</span>
                    {row.stale ? (
                      <span className="font-semibold text-warning">
                        {row.status === "new" ? "Sin atender" : "Sin convertir"}
                      </span>
                    ) : null}
                    <span>Formulario: {row.formName}</span>
                    <span>
                      {row.assignedToName
                        ? `A cargo de ${row.assignedToName}`
                        : open
                          ? "Sin responsable"
                          : ""}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {result.truncated ? (
            <p className="text-sm text-fg-muted">
              Mostrando las {REQUEST_LIST_LIMIT} más recientes. Usa los filtros para ver las demás.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
