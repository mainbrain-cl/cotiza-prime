"use client";

import { ExternalLink, Loader2, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormAlert, Input, Textarea } from "@/components/ui/form-controls";
import {
  BASIC_FORMAT_ERROR_MESSAGES,
  MAX_BODY_LENGTH,
  parseBasicFormat,
} from "@/lib/email/basic-format";
import { BUTTON_LABEL, MAX_SUBJECT_LENGTH } from "@/lib/email/quote-email";
import { sendQuoteAction } from "@/lib/quotes/send/actions";
import { cn } from "@/lib/utils";

// Si la respuesta no llegó, el correo pudo haber salido. Repetir con la misma clave de envío es
// seguro: si ya salió, solo se confirma; si no, se envía.
const OFFLINE_MESSAGE =
  "No sabemos si alcanzó a salir. Presiona Enviar de nuevo y te lo confirmamos: no se duplica.";
/** Caracteres de holgura de los campos sobre el máximo: la validación de arriba es la que manda. */
const SUBJECT_INPUT_SLACK = 20;
const BODY_INPUT_SLACK = 500;
const IN_PROGRESS_MESSAGE =
  "Tu envío sigue en curso. Espera unos segundos y revisa el estado de la cotización.";
const SENT_MESSAGE = "Cotización enviada.";
const FORMAT_HELP =
  "Puedes usar **negrita**, listas con «- » al inicio de la línea y enlaces como [texto](https://...).";

type Props = {
  tenantId: string;
  quoteId: string;
  expectedRevision: number;
  quotePath: string;
  initialSubject: string;
  initialBody: string;
  organizationName: string;
  brandPrimary: string;
  brandOnPrimary: string;
  brandText: string;
  customerName: string;
  maskedRecipient: string;
  replyTo: string | null;
  pdfSrc: string;
};

// Ancho desde el que el PDF se muestra incrustado (el `md` de Tailwind).
const FRAME_MIN_WIDTH_QUERY = "(min-width: 768px)";
const subscribeToWidth = (onChange: () => void) => {
  const query = window.matchMedia(FRAME_MIN_WIDTH_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const widthMatches = () => window.matchMedia(FRAME_MIN_WIDTH_QUERY).matches;
const widthOnServer = () => false;

/**
 * Redactar y enviar la cotización (H-029): asunto y texto con formato básico, y a la vista —lado a
 * lado en escritorio, apilados en teléfono— el correo como lo leerá el cliente y el PDF adjunto.
 * Lo que se envía es lo GUARDADO: el PDF se arma en el servidor con la última versión guardada.
 */
export function SendQuoteForm(props: Props) {
  const router = useRouter();
  const showFrame = useSyncExternalStore(subscribeToWidth, widthMatches, widthOnServer);
  const [subject, setSubject] = useState(props.initialSubject);
  const [body, setBody] = useState(props.initialBody);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // La misma clave en todos los intentos de este envío: un doble clic no duplica el correo.
  const sendKey = useRef(crypto.randomUUID());
  const busy = useRef(false);

  const formatted = useMemo(
    () => parseBasicFormat(body, { linkColor: props.brandText }),
    [body, props.brandText],
  );
  const bodyError = formatted.ok ? undefined : BASIC_FORMAT_ERROR_MESSAGES[formatted.code];
  const subjectEmpty = subject.trim() === "";
  const canSend = !pending && formatted.ok && !subjectEmpty;

  async function submit() {
    if (busy.current || !canSend) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    try {
      const result = await sendQuoteAction(props.tenantId, props.quoteId, {
        subject,
        body,
        expectedRevision: props.expectedRevision,
        sendKey: sendKey.current,
      });
      if (result.status === "sent") {
        toast.success(SENT_MESSAGE);
        router.push(props.quotePath);
        router.refresh();
        return;
      }
      if (result.status === "in_progress") {
        setNotice(IN_PROGRESS_MESSAGE);
      } else {
        setError(result.message);
        setFieldErrors(result.fieldErrors ?? {});
      }
    } catch {
      setError(OFFLINE_MESSAGE);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="send-quote">
      <form
        className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        noValidate
      >
        <h2 className="text-lg">Correo para tu cliente</h2>
        <p className="text-fg-muted">
          Se envía a <strong className="text-fg">{props.customerName}</strong> (
          {props.maskedRecipient})
          {props.replyTo ? <>; si responde, su respuesta llega a {props.replyTo}</> : null}.
        </p>
        <Field label="Asunto" error={fieldErrors.subject}>
          {(control) => (
            <Input
              {...control}
              name="subject"
              value={subject}
              maxLength={MAX_SUBJECT_LENGTH + SUBJECT_INPUT_SLACK}
              onChange={(event) => setSubject(event.target.value)}
              disabled={pending}
              data-testid="send-subject"
            />
          )}
        </Field>
        <Field label="Texto del correo" hint={FORMAT_HELP} error={fieldErrors.body ?? bodyError}>
          {(control) => (
            <Textarea
              {...control}
              name="body"
              rows={10}
              value={body}
              maxLength={MAX_BODY_LENGTH + BODY_INPUT_SLACK}
              onChange={(event) => setBody(event.target.value)}
              disabled={pending}
              data-testid="send-body"
            />
          )}
        </Field>
        {error ? <FormAlert>{error}</FormAlert> : null}
        {notice ? <FormAlert tone="warning">{notice}</FormAlert> : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          <Button
            type="submit"
            size="lg"
            disabled={!canSend}
            aria-disabled={!canSend}
            data-testid="send-submit"
          >
            {pending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                Enviando…
              </>
            ) : (
              <>
                <Send aria-hidden />
                Enviar
              </>
            )}
          </Button>
        </div>
      </form>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <section
          aria-label="Vista previa del correo"
          className="flex flex-col gap-3"
          data-testid="email-preview"
        >
          <h2 className="text-lg">Así lo leerá tu cliente</h2>
          <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-1">
            <div className="border-b border-border bg-surface-2 px-4 py-3 text-sm">
              <p className="text-fg-muted">
                De: <strong className="text-fg">{props.organizationName}</strong>
              </p>
              <p className="text-fg-muted">
                Asunto: <strong className="text-fg">{subject.trim() || "(sin asunto)"}</strong>
              </p>
            </div>
            <div
              className="px-4 py-3 text-base font-bold"
              style={{ background: props.brandPrimary, color: props.brandOnPrimary }}
            >
              {props.organizationName}
            </div>
            <div className="flex flex-col gap-4 px-4 py-5">
              {formatted.ok ? (
                // El HTML sale de nuestro lector del formato básico: todo lo escrito se escapa y los
                // enlaces solo pueden ser https. Nunca es HTML libre.
                <div
                  data-testid="email-preview-body"
                  className="text-base"
                  dangerouslySetInnerHTML={{ __html: formatted.html }}
                />
              ) : (
                <p className="text-sm text-danger">{bodyError}</p>
              )}
              <span
                className="inline-flex w-fit items-center rounded-sm px-5 py-3 text-sm font-bold"
                style={{ background: props.brandPrimary, color: props.brandOnPrimary }}
              >
                {BUTTON_LABEL}
              </span>
              <p className="text-sm text-fg-muted">
                Adjuntamos la cotización en PDF. El enlace del botón se genera al enviar.
              </p>
            </div>
          </div>
        </section>

        <section aria-label="Vista previa del PDF" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg">PDF adjunto</h2>
            <a
              href={props.pdfSrc}
              target="_blank"
              rel="noopener"
              className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
            >
              <ExternalLink aria-hidden className="size-4" />
              Abrir en otra pestaña
            </a>
          </div>
          {/* En teléfono el visor incrustado es incómodo y pesado: ni siquiera se carga; solo se
              ofrece abrir el PDF en otra pestaña (el botón de arriba, de 44 px de alto). */}
          {showFrame ? (
            <iframe
              title="PDF de la cotización"
              src={props.pdfSrc}
              data-testid="pdf-frame"
              className={cn(
                "h-[70vh] min-h-96 w-full rounded-lg border border-border bg-surface shadow-1",
              )}
            />
          ) : null}
          <p className="text-sm text-fg-muted">
            La fecha del documento será la del día en que lo envíes.
          </p>
        </section>
      </div>
    </div>
  );
}
