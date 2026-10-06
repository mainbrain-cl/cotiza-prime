"use client";

import { Check, CircleCheck, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import {
  ACCEPTANCE_TEXT,
  NAME_MAX_LENGTH,
  REASON_TEXT_MAX_LENGTH,
  REJECT_REASONS,
  acceptInputSchema,
  fieldErrorsOf,
  rejectInputSchema,
  type FieldErrors,
  type RespondOutcome,
} from "@/lib/share/respond";
import { cn } from "@/lib/utils";

/**
 * Los botones «Aceptar» y «Rechazar» del cliente final (H-031), con la marca de la organización.
 * Aceptar pide el nombre y una casilla de conformidad; rechazar exige elegir un motivo. La pantalla
 * valida con las mismas reglas del servidor, pero quien decide es el servidor: aquí solo se avisa
 * antes. Cada formulario lleva una clave propia: el mismo envío repetido (doble clic, reintento) no
 * registra dos veces, y otra pestaña recibe «ya respondiste» con lo que quedó.
 */

export type ResponsePanelProps = {
  /** Dirección base del enlace: `/api/v1/public/quote-links/{token}`. */
  apiBase: string;
  organizationName: string;
  /** Respuesta ya registrada (al abrir o recargar), con la fecha lista para mostrar. */
  initialResponse: { decision: "accepted" | "rejected"; dateText: string | null } | null;
  /** `true` solo si el enlace está vigente y la cotización está Enviada o Vista. */
  canRespond: boolean;
};

type Mode = "idle" | "accept" | "reject";
type Done = { decision: "accepted" | "rejected"; fresh: boolean };

const MSG_GENERIC_ERROR = "No pudimos registrar tu respuesta. Inténtalo de nuevo en un momento.";
const MSG_NETWORK_ERROR = "No pudimos conectarnos. Revisa tu conexión e inténtalo de nuevo.";

const BUTTON_BASE =
  "inline-flex h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-sm px-5 text-base font-semibold shadow-1 transition-colors focus-visible:ring-3 focus-visible:ring-[var(--brand)]/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";
const FIELD =
  "w-full rounded-sm border border-border-strong bg-surface px-3 py-2.5 text-[16px] text-fg focus-visible:ring-3 focus-visible:ring-[var(--brand)]/40 focus-visible:outline-none";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-sm font-medium text-danger">
      {message}
    </p>
  );
}

export function ResponsePanel({
  apiBase,
  organizationName,
  initialResponse,
  canRespond,
}: ResponsePanelProps) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [done, setDone] = useState<Done | null>(null);
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reasonCode, setReasonCode] = useState("");
  const [reasonText, setReasonText] = useState("");
  // Una clave por formulario: repetir el mismo envío no registra dos veces.
  const keys = useRef<{ accept?: string; reject?: string }>({});
  const keyFor = (kind: "accept" | "reject") => (keys.current[kind] ??= crypto.randomUUID());

  const final: Done | null =
    done ?? (initialResponse ? { decision: initialResponse.decision, fresh: false } : null);

  if (final) {
    return (
      <section
        data-testid="response-confirmation"
        role="status"
        aria-live="polite"
        className="flex items-start gap-3 rounded-md border border-border bg-[var(--brand-tint)] p-4 sm:p-5"
      >
        <CircleCheck aria-hidden strokeWidth={1.75} className="mt-0.5 size-6 shrink-0" />
        <div className="min-w-0">
          <h2 className="text-md font-semibold">
            {final.fresh ? "Listo, registramos tu respuesta" : "Ya respondiste esta cotización"}
          </h2>
          <p className="mt-1 text-base break-words">
            {final.fresh
              ? `${final.decision === "accepted" ? "Aceptaste" : "Rechazaste"} esta cotización. Avisamos a ${organizationName}.`
              : `${final.decision === "accepted" ? "La aceptaste" : "La rechazaste"}${
                  !done && initialResponse?.dateText ? ` el ${initialResponse.dateText}` : ""
                }. Ya no se puede cambiar desde este enlace.`}
          </p>
          <p className="mt-1 text-sm text-fg-muted">
            Si necesitas cambiar algo, escríbele directamente a {organizationName}. Puedes seguir
            descargando el PDF.
          </p>
        </div>
      </section>
    );
  }

  if (!canRespond) return null;

  async function send(kind: "accept" | "reject", payload: Record<string, unknown>) {
    setBusy(true);
    setErrors({});
    try {
      const response = await fetch(`${apiBase}/${kind}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as
        RespondOutcome | { status: "rate_limited"; message: string } | null;
      if (!body) {
        setErrors({ form: MSG_GENERIC_ERROR });
      } else if (body.status === "ok") {
        setDone({ decision: body.decision, fresh: true });
        router.refresh();
      } else if (body.status === "already_responded") {
        setDone({ decision: body.decision, fresh: false });
        router.refresh();
      } else if (body.status === "unavailable") {
        // Vencida, revocada o reemplazada: la página muestra el mensaje que corresponde.
        window.location.reload();
      } else if (body.status === "invalid") {
        setErrors(body.fieldErrors);
      } else if (body.status === "rate_limited") {
        setErrors({ form: body.message });
      } else {
        setErrors({ form: MSG_GENERIC_ERROR });
      }
    } catch {
      setErrors({ form: MSG_NETWORK_ERROR });
    } finally {
      setBusy(false);
    }
  }

  function submitAccept(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const payload = { responseKey: keyFor("accept"), name, confirmed };
    const parsed = acceptInputSchema.safeParse(payload);
    if (!parsed.success) return setErrors(fieldErrorsOf(parsed.error));
    void send("accept", parsed.data);
  }

  function submitReject(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const payload = {
      responseKey: keyFor("reject"),
      reasonCode: reasonCode || undefined,
      reasonText: reasonCode === "other" ? reasonText : undefined,
    };
    const parsed = rejectInputSchema.safeParse(payload);
    if (!parsed.success) return setErrors(fieldErrorsOf(parsed.error));
    void send("reject", parsed.data);
  }

  const open = (next: Mode) => {
    setErrors({});
    setMode(next);
  };

  return (
    <section
      aria-label="Responder la cotización"
      data-testid="response-panel"
      className="flex flex-col gap-4"
    >
      {mode === "idle" ? (
        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            data-testid="response-accept-open"
            onClick={() => open("accept")}
            className={cn(BUTTON_BASE, "bg-[var(--brand)] text-[var(--on-brand)] hover:opacity-90")}
          >
            <Check aria-hidden strokeWidth={1.75} className="size-5" />
            Aceptar
          </button>
          <button
            type="button"
            data-testid="response-reject-open"
            onClick={() => open("reject")}
            className={cn(
              BUTTON_BASE,
              "border border-border-strong bg-surface text-fg hover:bg-surface-2",
            )}
          >
            <X aria-hidden strokeWidth={1.75} className="size-5" />
            Rechazar
          </button>
        </div>
      ) : null}

      {mode === "accept" ? (
        <form
          onSubmit={submitAccept}
          noValidate
          data-testid="accept-form"
          className="flex flex-col gap-4 rounded-md border border-border p-4 sm:p-5"
        >
          <h2 className="text-md font-semibold">Aceptar la cotización</h2>
          <div>
            <label htmlFor="accept-name" className="text-sm font-medium">
              Tu nombre
            </label>
            <input
              id="accept-name"
              data-testid="accept-name"
              type="text"
              autoComplete="name"
              maxLength={NAME_MAX_LENGTH}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? "accept-name-error" : undefined}
              className={cn(FIELD, "mt-1")}
            />
            <FieldError id="accept-name-error" message={errors.name} />
          </div>
          <div>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                data-testid="accept-confirm"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                aria-invalid={Boolean(errors.confirmed)}
                aria-describedby={errors.confirmed ? "accept-confirm-error" : undefined}
                className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]"
              />
              <span>{ACCEPTANCE_TEXT}</span>
            </label>
            <FieldError id="accept-confirm-error" message={errors.confirmed} />
          </div>
          <FieldError id="accept-form-error" message={errors.form} />
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="submit"
              data-testid="accept-submit"
              disabled={busy}
              className={cn(
                BUTTON_BASE,
                "bg-[var(--brand)] text-[var(--on-brand)] hover:opacity-90",
              )}
            >
              {busy ? "Enviando…" : "Confirmar aceptación"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => open("idle")}
              className={cn(
                BUTTON_BASE,
                "border border-border-strong bg-surface text-fg hover:bg-surface-2",
              )}
            >
              Volver
            </button>
          </div>
        </form>
      ) : null}

      {mode === "reject" ? (
        <form
          onSubmit={submitReject}
          noValidate
          data-testid="reject-form"
          className="flex flex-col gap-4 rounded-md border border-border p-4 sm:p-5"
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="text-md font-semibold">¿Por qué rechazas la cotización?</legend>
            <p className="text-sm text-fg-muted">Elige un motivo: nos ayuda a mejorar.</p>
            {REJECT_REASONS.map((reason) => (
              <label
                key={reason.code}
                className="flex min-h-11 items-center gap-3 rounded-sm border border-border px-3 text-base"
              >
                <input
                  type="radio"
                  name="reason"
                  value={reason.code}
                  data-testid={`reject-reason-${reason.code}`}
                  checked={reasonCode === reason.code}
                  onChange={() => setReasonCode(reason.code)}
                  className="size-5 shrink-0 accent-[var(--brand)]"
                />
                {reason.label}
              </label>
            ))}
            <FieldError id="reject-reason-error" message={errors.reasonCode} />
          </fieldset>
          {reasonCode === "other" ? (
            <div>
              <label htmlFor="reject-reason-text" className="text-sm font-medium">
                Cuéntanos brevemente el motivo
              </label>
              <textarea
                id="reject-reason-text"
                data-testid="reject-reason-text"
                rows={3}
                maxLength={REASON_TEXT_MAX_LENGTH}
                value={reasonText}
                onChange={(event) => setReasonText(event.target.value)}
                aria-invalid={Boolean(errors.reasonText)}
                aria-describedby={errors.reasonText ? "reject-reason-text-error" : undefined}
                className={cn(FIELD, "mt-1")}
              />
              <FieldError id="reject-reason-text-error" message={errors.reasonText} />
            </div>
          ) : null}
          <FieldError id="reject-form-error" message={errors.form} />
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="submit"
              data-testid="reject-submit"
              disabled={busy}
              className={cn(
                BUTTON_BASE,
                "bg-[var(--brand)] text-[var(--on-brand)] hover:opacity-90",
              )}
            >
              {busy ? "Enviando…" : "Confirmar rechazo"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => open("idle")}
              className={cn(
                BUTTON_BASE,
                "border border-border-strong bg-surface text-fg hover:bg-surface-2",
              )}
            >
              Volver
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
