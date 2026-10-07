"use client";

import { useEffect, useRef, useState } from "react";
import type {
  RequestSummary as RequestSummaryModel,
  SummaryLine,
} from "@/lib/intake/summary-model";
import { cn } from "@/lib/utils";

/**
 * El resumen de lo que se está pidiendo (H-088): el MISMO componente lo ve quien llena el formulario público
 * y el equipo en el detalle de la solicitud, así «lo que veo es exactamente lo que recibirá la empresa».
 *
 * Solo dibuja el modelo de `buildRequestSummary`: textos, sin ningún monto (el modelo no tiene dónde
 * guardarlo). Todo lo que escribió el visitante se pinta como texto plano, nunca como HTML.
 *
 * `announce` (solo en el formulario público): un aviso breve y sin spam para lectores de pantalla, que
 * espera a que la persona deje de escribir antes de hablar. El resumen en sí no es una región en vivo: así
 * no se lee entero con cada tecla.
 */

const ANNOUNCE_DELAY_MS = 1_200;
export const EMPTY_SERVICES_TEXT = "Sin servicios elegidos.";
export const EMPTY_SUMMARY_TEXT = "Aquí irá el resumen de tu solicitud a medida que la llenes.";

function Lines({ lines, testId }: { lines: SummaryLine[]; testId: string }) {
  return (
    <dl data-testid={testId} className="flex flex-col gap-2">
      {lines.map((line) => (
        <div key={line.key} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-sm text-fg-muted">{line.label}</dt>
          <dd
            data-testid={`request-summary-${line.key}`}
            className={cn("min-w-0 break-words text-fg", line.multiline && "whitespace-pre-wrap")}
          >
            {line.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Heading({ children }: { children: string }) {
  return (
    <h3 className="text-xs font-semibold tracking-[0.08em] text-fg-muted uppercase">{children}</h3>
  );
}

export function announcementFor(summary: RequestSummaryModel): string {
  if (summary.isEmpty) return "Tu resumen está vacío.";
  const services =
    summary.itemCount === 1 ? "1 servicio elegido" : `${summary.itemCount} servicios elegidos`;
  const data = summary.contact.length + summary.details.length;
  return `Resumen actualizado: ${services} y ${data === 1 ? "1 dato" : `${data} datos`}.`;
}

export function RequestSummary({
  summary,
  announce = false,
  className,
}: {
  summary: RequestSummaryModel;
  announce?: boolean;
  className?: string;
}) {
  const [announcement, setAnnouncement] = useState("");
  const first = useRef(true);
  const text = announcementFor(summary);

  useEffect(() => {
    if (!announce) return;
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => setAnnouncement(text), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [announce, text]);

  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)} data-testid="request-summary">
      <div data-testid="request-summary-body" className="flex min-w-0 flex-col gap-4">
        {summary.isEmpty ? (
          <p className="text-fg-muted">{EMPTY_SUMMARY_TEXT}</p>
        ) : (
          <>
            <section className="flex min-w-0 flex-col gap-2" aria-label="Servicios">
              <Heading>Servicios</Heading>
              {summary.services.length === 0 ? (
                <p className="text-fg-muted">{EMPTY_SERVICES_TEXT}</p>
              ) : (
                <ul data-testid="request-summary-services" className="flex flex-col gap-2">
                  {summary.services.map((line) => (
                    <li
                      key={line.key}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 rounded-sm bg-surface-2 px-3 py-2"
                    >
                      <span className="min-w-0 font-medium break-words">{line.label}</span>
                      {line.value ? (
                        <span className="text-sm text-fg-muted">{line.value}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {summary.contact.length > 0 ? (
              <section className="flex min-w-0 flex-col gap-2" aria-label="Datos de contacto">
                <Heading>Datos de contacto</Heading>
                <Lines lines={summary.contact} testId="request-summary-contact" />
              </section>
            ) : null}
            {summary.details.length > 0 ? (
              <section className="flex min-w-0 flex-col gap-2" aria-label="Detalles">
                <Heading>Detalles</Heading>
                <Lines lines={summary.details} testId="request-summary-details" />
              </section>
            ) : null}
          </>
        )}
      </div>
      {announce ? (
        <p role="status" aria-live="polite" aria-atomic className="sr-only">
          {announcement}
        </p>
      ) : null}
    </div>
  );
}
