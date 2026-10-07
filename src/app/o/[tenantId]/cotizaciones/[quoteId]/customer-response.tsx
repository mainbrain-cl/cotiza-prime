import { CircleCheck, CircleX } from "lucide-react";
import { formatDate } from "@/lib/format-date";
import {
  responseHeadline,
  responseReason,
  type QuoteResponseView,
} from "@/lib/quotes/response-text";

/**
 * Lo que respondió el cliente, para los miembros de la organización (H-031). Aquí sí aparece el
 * nombre de quien aceptó y el comentario del rechazo: el correo de aviso solo trae número y decisión.
 * React escapa todo lo que escribió el cliente.
 */
export function CustomerResponse({ response }: { response: QuoteResponseView | null }) {
  if (response === null) return null;
  const accepted = response.decision === "accepted";
  const Icon = accepted ? CircleCheck : CircleX;
  const reason = responseReason(response);
  return (
    <section
      aria-label="Respuesta del cliente"
      data-testid="customer-response"
      className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
    >
      <Icon
        aria-hidden
        strokeWidth={1.75}
        className={
          accepted ? "mt-0.5 size-6 shrink-0 text-success" : "mt-0.5 size-6 shrink-0 text-danger"
        }
      />
      <div className="min-w-0">
        <h2 className="text-lg break-words" data-testid="customer-response-headline">
          {responseHeadline(response, formatDate(response.respondedAt))}
        </h2>
        {reason ? (
          <p className="mt-1" data-testid="customer-response-reason">
            <span className="text-fg-muted">Motivo:</span> {reason}
          </p>
        ) : null}
        {response.reasonText ? (
          <p className="mt-1 break-words" data-testid="customer-response-detail">
            <span className="text-fg-muted">Detalle que escribió el cliente:</span>{" "}
            {response.reasonText}
          </p>
        ) : null}
        {response.unreadable ? (
          <p className="mt-1 text-sm text-fg-muted">
            Una parte de la respuesta no se pudo leer. Avísale a soporte.
          </p>
        ) : null}
      </div>
    </section>
  );
}
