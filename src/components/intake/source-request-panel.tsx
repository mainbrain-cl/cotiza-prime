import { Inbox } from "lucide-react";
import Link from "next/link";
import { formatDateTime } from "@/lib/format-date";
import type { SourceRequestPanel } from "@/lib/intake/convert-queries";
import { DATA_DELETED_LABEL, formatRequestQuantity } from "@/lib/intake/requests-model";
import { tenantPath } from "@/lib/tenant/constants";

/** `2026-10-07` → `07-10-2026`, sin pasar por zonas horarias (es una fecha, no un instante). */
function formatPlainDate(value: string): string {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}-${month}-${year}` : value;
}

/**
 * «Solicitud original» (H-090): lo que pidió quien llenó el formulario, dentro de la cotización que
 * nació de ahí. Solo para el equipo (la cotización del cliente y el PDF no lo llevan). Todo lo que
 * escribió el visitante va como texto plano de React: nunca HTML.
 */
export function SourceRequestPanelView({
  tenantId,
  panel,
}: {
  tenantId: string;
  panel: SourceRequestPanel;
}) {
  return (
    <section
      aria-labelledby="source-request-title"
      data-testid="source-request"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="source-request-title" className="flex items-center gap-2 text-lg">
            <Inbox aria-hidden className="size-5 text-fg-muted" />
            Solicitud original
          </h2>
          <p className="text-sm text-fg-muted">
            Solo la ve tu equipo: no aparece en la cotización, el correo ni el PDF del cliente.
            Pedida el {formatDateTime(panel.createdAt)}.
          </p>
        </div>
        <Link
          href={tenantPath(tenantId, `solicitudes/${panel.requestId}`)}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-accent hover:underline"
        >
          Ver la solicitud
        </Link>
      </div>

      {panel.unreadable ? (
        <p
          role="alert"
          className="rounded-sm bg-warning-soft px-3 py-2.5 text-sm font-medium text-warning"
        >
          No pudimos leer algunos datos de la solicitud. Avísanos si sigue pasando.
        </p>
      ) : null}

      {panel.notLoaded.length > 0 ? (
        <p
          role="status"
          data-testid="request-not-loaded"
          className="rounded-sm bg-warning-soft px-3 py-2.5 text-sm font-medium text-warning"
        >
          No cargamos {panel.notLoaded.length === 1 ? "este servicio" : "estos servicios"} porque ya
          no {panel.notLoaded.length === 1 ? "está activo" : "están activos"} en tu catálogo:{" "}
          {panel.notLoaded.map((service) => service.name).join(", ")}. Agrégalo como línea libre si
          todavía lo vas a cotizar.
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg">Servicios pedidos</h3>
        {panel.services.length === 0 ? (
          <p className="text-fg-muted">No eligió servicios.</p>
        ) : (
          <ul data-testid="source-request-items" className="flex flex-col gap-2">
            {panel.services.map((service, index) => (
              <li
                key={`${service.name}-${index}`}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 rounded-sm bg-surface-2 px-3 py-2"
              >
                <span className="font-medium break-words">{service.name}</span>
                <span className="text-sm text-fg-muted">
                  {formatRequestQuantity({
                    name: service.name,
                    unit: service.unit,
                    quantityMilli: service.quantityMilli,
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {panel.anonymized ? (
        <p data-testid="source-request-deleted" className="text-sm text-fg-muted">
          {DATA_DELETED_LABEL}: el mensaje y los datos de quien pidió se eliminaron.
        </p>
      ) : (
        <>
          {panel.serviceAddress || panel.comuna || panel.desiredDate ? (
            <dl className="flex flex-col gap-1 text-sm">
              {panel.serviceAddress ? (
                <div className="flex flex-wrap gap-x-3">
                  <dt className="text-fg-muted">Dirección del servicio</dt>
                  <dd className="min-w-0 break-words whitespace-pre-wrap">
                    {panel.serviceAddress}
                  </dd>
                </div>
              ) : null}
              {panel.comuna ? (
                <div className="flex flex-wrap gap-x-3">
                  <dt className="text-fg-muted">Comuna</dt>
                  <dd className="min-w-0 break-words">{panel.comuna}</dd>
                </div>
              ) : null}
              {panel.desiredDate ? (
                <div className="flex flex-wrap gap-x-3">
                  <dt className="text-fg-muted">Fecha deseada</dt>
                  <dd>{formatPlainDate(panel.desiredDate)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {panel.message ? (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-fg">Mensaje</h3>
              <p
                data-testid="source-request-message"
                className="break-words whitespace-pre-wrap text-fg"
              >
                {panel.message}
              </p>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
