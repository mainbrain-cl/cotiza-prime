import { ChevronLeft, ChevronRight, ScrollText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormAlert, Select } from "@/components/ui/form-controls";
import {
  AUDIT_ACTION_LABELS,
  actionLabel,
  describeAuditEntry,
  describeAuditSubject,
} from "@/lib/audit/labels";
import {
  listAuditActors,
  listAuditEntries,
  sanitizeAuditFilters,
  type AuditEntry,
} from "@/lib/audit/queries";
import { formatDateTime } from "@/lib/format-date";
import { pagePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";

export const metadata: Metadata = { title: "Registro de actividad · Cotiza Prime" };

const EMPTY = "—";

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function actorText(entry: AuditEntry): string {
  if (entry.actorName) return entry.actorName;
  if (entry.actorType === "system") return "El sistema";
  if (entry.actorType === "public") return "Una visita sin cuenta";
  if (entry.actorType === "service") return "Un servicio automático";
  return "Alguien que ya no está en el equipo";
}

function resultText(result: AuditEntry["result"]): string | null {
  if (result === "failure") return "No se pudo completar";
  if (result === "denied") return "Se negó el permiso";
  return null;
}

export default async function ActivityLogPage({
  params,
  searchParams,
}: PageProps<"/o/[tenantId]/configuracion/actividad">) {
  const active = await requireActiveTenant((await params).tenantId);
  // Solo el Dueño (supuesto 13); antes de leer cualquier dato.
  const denied = pagePermission(active, "audit.read");
  if (denied) return denied;

  const query = await searchParams;
  const filters = sanitizeAuditFilters({
    actor: firstValue(query.persona),
    action: firstValue(query.accion),
    page: Number(firstValue(query.pagina)) || 1,
  });
  const [result, actors] = await Promise.all([
    listAuditEntries(active, filters),
    listAuditActors(active),
  ]);
  const filtering = filters.actor !== null || filters.action !== null;
  const basePath = tenantPath(active.tenantId, "configuracion/actividad");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href={tenantPath(active.tenantId, "configuracion")}
          className="inline-flex min-h-11 w-fit items-center gap-1 rounded-sm text-sm font-medium text-fg-muted outline-none hover:text-fg focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Configuración
        </Link>
        <h1 className="text-xl md:text-2xl">Registro de actividad</h1>
        <p className="max-w-2xl text-fg-muted">
          Quién hizo cada acción sensible en tu organización, y cuándo. Nadie puede editar ni borrar
          este registro, tampoco tú.
        </p>
      </div>

      <form
        key={`${filters.actor ?? ""}|${filters.action ?? ""}`}
        method="get"
        action={basePath}
        role="search"
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex w-full flex-col gap-1.5 md:w-60">
          <label htmlFor="audit-actor" className="text-sm font-semibold text-fg">
            Persona
          </label>
          <Select id="audit-actor" name="persona" defaultValue={filters.actor ?? ""}>
            <option value="">Todas las personas</option>
            {actors.map((actor) => (
              <option key={actor.userId} value={actor.userId}>
                {actor.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex w-full flex-col gap-1.5 md:w-80">
          <label htmlFor="audit-action" className="text-sm font-semibold text-fg">
            Tipo de acción
          </label>
          <Select id="audit-action" name="accion" defaultValue={filters.action ?? ""}>
            <option value="">Todas las acciones</option>
            {Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <button type="submit" className={buttonVariants({ variant: "secondary", size: "default" })}>
          Filtrar
        </button>
        {filtering ? (
          <Link
            href={basePath}
            className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline underline-offset-4 md:min-h-9"
          >
            Limpiar filtros
          </Link>
        ) : null}
      </form>

      {result === null ? (
        <FormAlert>
          No pudimos cargar el registro de actividad. Recarga la página en unos minutos.
        </FormAlert>
      ) : result.entries.length === 0 && filtering ? (
        <div
          role="status"
          data-testid="no-results"
          className="rounded-lg border border-border bg-surface p-6 text-center text-fg-muted shadow-1"
        >
          No hay actividad con esos filtros. Usa «Limpiar filtros» para ver todo el registro.
        </div>
      ) : result.entries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="Aún no hay actividad"
          description="Aquí aparecerán los ingresos, los cambios de configuración y las demás acciones sensibles de tu equipo."
        />
      ) : (
        <>
          {/* Teléfono: tarjetas */}
          <ul className="flex flex-col gap-3 md:hidden" data-testid="audit-cards">
            {result.entries.map((entry) => {
              const detail = describeAuditEntry(entry);
              const failed = resultText(entry.result);
              return (
                <li
                  key={entry.id}
                  className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4 shadow-1"
                >
                  <span className="text-sm text-fg-muted tabular-nums">
                    {formatDateTime(entry.occurredAt)}
                  </span>
                  <span className="font-semibold text-fg">{actionLabel(entry.action)}</span>
                  <span className="text-fg">{actorText(entry)}</span>
                  <span className="text-sm text-fg-muted">
                    {describeAuditSubject(entry)}
                    {detail ? ` · ${detail}` : ""}
                  </span>
                  {failed ? (
                    <span className="text-sm font-semibold text-danger">{failed}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {/* Escritorio: tabla */}
          <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface shadow-1 md:block">
            <table className="w-full text-left text-sm" data-testid="audit-table">
              <thead className="bg-surface-2 text-fg-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Fecha y hora
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Quién
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Qué hizo
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Sobre qué
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Desde
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.entries.map((entry) => {
                  const detail = describeAuditEntry(entry);
                  const failed = resultText(entry.result);
                  return (
                    <tr
                      key={entry.id}
                      className="align-top hover:bg-surface-2"
                      data-testid="audit-row"
                    >
                      <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                        {formatDateTime(entry.occurredAt)}
                      </td>
                      <td className="px-4 py-3">{actorText(entry)}</td>
                      <td className="px-4 py-3">
                        <span className="font-semibold text-fg">{actionLabel(entry.action)}</span>
                        {detail ? <span className="block text-fg-muted">{detail}</span> : null}
                        {failed ? (
                          <span className="block font-semibold text-danger">{failed}</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">{describeAuditSubject(entry)}</td>
                      <td className="px-4 py-3 text-fg-muted tabular-nums">
                        {entry.originIp ?? EMPTY}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {result.pageCount > 1 ? (
            <nav
              aria-label="Páginas del registro"
              className="flex items-center justify-between gap-3"
            >
              <PageLink
                href={pageHref(basePath, filters, result.page - 1)}
                disabled={result.page <= 1}
              >
                <ChevronLeft aria-hidden />
                Anterior
              </PageLink>
              <p className="text-center text-sm text-fg-muted" data-testid="page-status">
                Página {result.page} de {result.pageCount} · {result.total} registros
              </p>
              <PageLink
                href={pageHref(basePath, filters, result.page + 1)}
                disabled={result.page >= result.pageCount}
              >
                Siguiente
                <ChevronRight aria-hidden />
              </PageLink>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}

function pageHref(
  basePath: string,
  filters: { actor: string | null; action: string | null },
  page: number,
): string {
  const params = new URLSearchParams();
  if (filters.actor) params.set("persona", filters.actor);
  if (filters.action) params.set("accion", filters.action);
  if (page > 1) params.set("pagina", String(page));
  const queryString = params.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}

function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className={buttonVariants({ variant: "secondary", size: "default" }) + " opacity-50"}
      >
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className={buttonVariants({ variant: "secondary", size: "default" })}>
      {children}
    </Link>
  );
}
