"use client";

import { ExternalLink, Loader2, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormAlert, Input, Select, Textarea } from "@/components/ui/form-controls";
import {
  BASIC_FORMAT_ERROR_MESSAGES,
  MAX_BODY_LENGTH,
  parseBasicFormat,
} from "@/lib/email/basic-format";
import { BUTTON_LABEL, MAX_SUBJECT_LENGTH } from "@/lib/email/quote-email";
import { sendQuoteAction } from "@/lib/quotes/send/actions";
import { isEmailBodyEdited, type EmailSnippetOption } from "@/lib/snippets/email-body";
import { hasUnresolvedVariables } from "@/lib/snippets/model";
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
const UNRESOLVED_VARIABLES_MESSAGE =
  "El texto todavía tiene una variable sin completar ({{ }}). Escribe el dato en su lugar o elige el texto guardado de nuevo.";
const SNIPPETS_UNAVAILABLE_MESSAGE =
  "No pudimos cargar tus textos guardados. Puedes escribir el correo a mano o recargar la página.";
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
  /** Los textos de correo guardados, ya con las variables completadas con los datos de esta cotización (H-048b). */
  snippetOptions: EmailSnippetOption[];
  /** `true` si no se pudieron leer los textos guardados. */
  snippetsUnavailable: boolean;
  /** El texto de siempre (el de partida cuando la organización no tiene un texto inicial): se puede volver a él. */
  defaultText: string;
};

const DEFAULT_CHOICE_ID = "__texto-de-siempre__";
const DEFAULT_CHOICE_NAME = "Texto de siempre";

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
  // Lo último que se puso en el cuadro desde un texto guardado (o el de partida): si la persona lo cambió, reemplazarlo pide confirmar.
  const [appliedText, setAppliedText] = useState(props.initialBody);
  const [pendingSnippet, setPendingSnippet] = useState<EmailSnippetOption | null>(null);
  const [snippetNotice, setSnippetNotice] = useState("");
  // El texto elegido en la lista, todavía sin aplicar: elegir en la lista no cambia el correo, lo cambia «Usar este texto» (con el teclado,
  // las flechas recorren la lista sin disparar nada).
  const [selectedId, setSelectedId] = useState("");
  const selectRef = useRef<HTMLSelectElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const choices = useMemo<EmailSnippetOption[]>(
    () => [
      {
        id: DEFAULT_CHOICE_ID,
        name: DEFAULT_CHOICE_NAME,
        text: props.defaultText,
        isDefault: false,
      },
      ...props.snippetOptions,
    ],
    [props.defaultText, props.snippetOptions],
  );
  // La confirmación se anuncia a quien usa lector de pantalla: el foco pasa a «Reemplazar el texto».
  useEffect(() => {
    if (pendingSnippet) replaceRef.current?.focus();
  }, [pendingSnippet]);
  // La misma clave en todos los intentos de este envío: un doble clic no duplica el correo.
  const sendKey = useRef(crypto.randomUUID());
  const busy = useRef(false);

  const formatted = useMemo(
    () => parseBasicFormat(body, { linkColor: props.brandText }),
    [body, props.brandText],
  );
  const bodyError = formatted.ok ? undefined : BASIC_FORMAT_ERROR_MESSAGES[formatted.code];
  const subjectEmpty = subject.trim() === "";
  const unresolved = hasUnresolvedVariables(body);
  const canSend = !pending && formatted.ok && !subjectEmpty && !unresolved;

  function applySnippet(option: EmailSnippetOption) {
    setBody(option.text);
    setAppliedText(option.text);
    setPendingSnippet(null);
    setSelectedId("");
    // Se quita el error del texto que había (no se deja vacío: un texto vacío taparía el error de formato en vivo).
    setFieldErrors((current) => {
      const next = { ...current };
      delete next.body;
      return next;
    });
    setSnippetNotice(`Texto «${option.name}» puesto en el correo.`);
  }
  function useSelectedSnippet() {
    const option = choices.find((candidate) => candidate.id === selectedId);
    if (!option) return;
    // Si la persona escribió o cambió el texto, no se pierde en silencio: se pide confirmar.
    if (isEmailBodyEdited(body, appliedText)) setPendingSnippet(option);
    else applySnippet(option);
  }

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
        {props.snippetsUnavailable ? (
          <FormAlert tone="warning">{SNIPPETS_UNAVAILABLE_MESSAGE}</FormAlert>
        ) : props.snippetOptions.length > 0 ? (
          <Field label="Usar un texto guardado">
            {(control) => (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select
                  {...control}
                  ref={selectRef}
                  name="snippet"
                  value={selectedId}
                  onChange={(event) => setSelectedId(event.target.value)}
                  disabled={pending}
                  className="sm:flex-1"
                  data-testid="send-snippet-select"
                >
                  <option value="">Elige un texto guardado…</option>
                  {choices.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                      {option.isDefault ? " (texto inicial)" : ""}
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending || selectedId === ""}
                  onClick={useSelectedSnippet}
                  data-testid="send-snippet-use"
                >
                  Usar este texto
                </Button>
              </div>
            )}
          </Field>
        ) : null}
        {pendingSnippet ? (
          <div
            role="alertdialog"
            aria-label="Reemplazar el texto del correo"
            data-testid="send-snippet-confirm"
            className="flex flex-col gap-3 rounded-md border border-warning bg-warning-soft p-3 text-sm text-fg"
          >
            <p>
              Cambiaste el texto del correo. Si eliges «{pendingSnippet.name}», se reemplaza lo que
              escribiste.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                ref={replaceRef}
                type="button"
                size="sm"
                onClick={() => applySnippet(pendingSnippet)}
                data-testid="send-snippet-replace"
              >
                Reemplazar el texto
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setPendingSnippet(null);
                  selectRef.current?.focus();
                }}
                data-testid="send-snippet-keep"
              >
                Mantener lo que escribí
              </Button>
            </div>
          </div>
        ) : null}
        <p role="status" aria-live="polite" className="sr-only">
          {snippetNotice}
        </p>
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
        {unresolved ? (
          <div data-testid="send-unresolved-variables">
            <FormAlert tone="warning">{UNRESOLVED_VARIABLES_MESSAGE}</FormAlert>
          </div>
        ) : null}
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
