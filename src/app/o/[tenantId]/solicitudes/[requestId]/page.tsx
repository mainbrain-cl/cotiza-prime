import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ROLE_LABELS } from "@/components/app-shell/app-shell";
import { RequestSummary } from "@/components/intake/request-summary";
import { RequestActions } from "@/components/intake/request-actions";
import { RequestStatusBadge } from "@/components/intake/request-status-badge";
import { formatDateTime } from "@/lib/format-date";
import { loadAssignableMembers, loadRequest } from "@/lib/intake/requests-queries";
import {
  DATA_DELETED_LABEL,
  discardReasonLabel,
  requestPermissions,
  timeSince,
} from "@/lib/intake/requests-model";
import { buildStoredRequestSummary } from "@/lib/intake/stored-summary";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";

export const metadata: Metadata = { title: "Solicitud · Cotiza Prime" };

/** `2026-10-07` → `07-10-2026`, sin pasar por zonas horarias (es una fecha, no un instante). */
function formatPlainDate(value: string): string {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}-${month}-${year}` : value;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="text-sm text-fg-muted sm:w-40 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 break-words whitespace-pre-wrap text-fg">{children}</dd>
    </div>
  );
}

function Panel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
    >
      <h2 id={id} className="text-lg">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function RequestDetailPage({
  params,
}: PageProps<"/o/[tenantId]/solicitudes/[requestId]">) {
  const { tenantId, requestId } = await params;
  const active = await requireActiveTenant(tenantId);
  const result = await loadRequest(active, requestId);
  if (!result.ok && result.reason === "not_found") notFound();

  const listPath = tenantPath(active.tenantId, "solicitudes");
  const back = (
    <Link
      href={listPath}
      className="inline-flex min-h-11 w-fit items-center gap-1 rounded-sm text-sm font-medium text-fg-muted outline-none hover:text-fg focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      <ChevronLeft aria-hidden className="size-4" />
      Solicitudes
    </Link>
  );
  if (!result.ok) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <p
          role="alert"
          data-testid="request-load-error"
          className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm font-medium text-danger"
        >
          No pudimos cargar esta solicitud. Recarga la página en unos minutos.
        </p>
      </div>
    );
  }

  const request = result.detail;
  const permissions = requestPermissions(active.role, active.userId, {
    status: request.status,
    assignedTo: request.assignedToId,
    anonymized: request.anonymized,
  });
  const members = permissions.canAssign ? await loadAssignableMembers(active) : [];
  const assignees =
    members === null
      ? null
      : members.map((member) => ({
          userId: member.userId,
          label: `${member.name} · ${ROLE_LABELS[member.role]}`,
        }));
  const { contact } = request;
  const requestSummary = buildStoredRequestSummary(request);

  return (
    <div className="flex flex-col gap-6">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 data-testid="request-title" className="text-xl break-words md:text-2xl">
            {request.anonymized ? DATA_DELETED_LABEL : (contact.name ?? "Solicitud")}
          </h1>
          <p className="text-fg-muted" title={formatDateTime(request.createdAt)}>
            {timeSince(request.createdAt)} · {formatDateTime(request.createdAt)}
          </p>
        </div>
        <RequestStatusBadge status={request.status} />
      </header>

      {request.unreadable ? (
        <p
          role="alert"
          className="rounded-sm bg-warning-soft px-3 py-2.5 text-sm font-medium text-warning"
        >
          No pudimos leer algunos datos de esta solicitud. Avísanos si sigue pasando.
        </p>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Panel id="contact-title" title="Quién la envió">
            {request.anonymized ? (
              <p data-testid="data-deleted" className="text-fg-muted">
                {DATA_DELETED_LABEL}. Estos datos se eliminaron y no se pueden recuperar.
              </p>
            ) : (
              <dl data-testid="request-contact" className="flex flex-col gap-3">
                <Row label="Nombre">{contact.name ?? "—"}</Row>
                <Row label="Correo">{contact.email ?? "—"}</Row>
                {contact.phone ? <Row label="Teléfono">{contact.phone}</Row> : null}
                {contact.company ? <Row label="Empresa">{contact.company}</Row> : null}
                {contact.comuna ? <Row label="Comuna">{contact.comuna}</Row> : null}
                {contact.serviceAddress ? (
                  <Row label="Dirección del servicio">{contact.serviceAddress}</Row>
                ) : null}
                {request.desiredDate ? (
                  <Row label="Fecha deseada">{formatPlainDate(request.desiredDate)}</Row>
                ) : null}
              </dl>
            )}
          </Panel>

          <Panel id="items-title" title="Lo que pidió">
            {/* El mismo resumen que vio quien llenó el formulario (H-088). */}
            <div data-testid="request-items">
              <RequestSummary summary={requestSummary} />
            </div>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <RequestActions
            tenantId={active.tenantId}
            requestId={request.id}
            permissions={permissions}
            assignees={assignees}
            currentAssigneeId={request.assignedToId}
          />

          <Panel id="status-title" title="Seguimiento">
            <dl className="flex flex-col gap-3 text-sm">
              <Row label="Formulario">
                <Link
                  href={tenantPath(active.tenantId, `formularios/${request.formId}`)}
                  className="font-medium text-accent hover:underline"
                >
                  {request.formName}
                </Link>
              </Row>
              <Row label="A cargo de">
                <span data-testid="request-assignee">
                  {request.assignedToName ?? "Nadie todavía"}
                </span>
              </Row>
              {request.assignedAt ? (
                <Row label="Asignada">{formatDateTime(request.assignedAt)}</Row>
              ) : null}
              {request.status === "discarded" ? (
                <>
                  <Row label="Motivo del descarte">{discardReasonLabel(request.discardReason)}</Row>
                  {request.discardNote ? <Row label="Nota">{request.discardNote}</Row> : null}
                </>
              ) : null}
              {request.status === "converted" && request.quoteId ? (
                <Row label="Cotización">
                  <Link
                    href={tenantPath(active.tenantId, `cotizaciones/${request.quoteId}`)}
                    className="font-medium text-accent hover:underline"
                  >
                    Ver la cotización
                  </Link>
                </Row>
              ) : null}
            </dl>
          </Panel>

          <Panel id="consent-title" title="Consentimiento">
            <dl data-testid="request-consent" className="flex flex-col gap-3 text-sm">
              <Row label="Aceptado el">{formatDateTime(request.consent.consentedAt)}</Row>
              <Row label="Versión del aviso">{request.consent.templateVersion}</Row>
            </dl>
            {request.consent.text ? (
              <details className="text-sm">
                <summary className="min-h-11 cursor-pointer py-2 font-medium text-accent md:min-h-0 md:py-0">
                  Ver el texto que aceptó
                </summary>
                <p className="mt-2 break-words whitespace-pre-wrap text-fg-muted">
                  {request.consent.text}
                </p>
              </details>
            ) : request.consent.textUnavailable ? (
              <p className="text-sm text-fg-muted">
                El texto exacto no quedó guardado para esta solicitud, solo su versión.
              </p>
            ) : null}
          </Panel>
        </div>
      </div>
    </div>
  );
}
