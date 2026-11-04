"use client";

import { Loader2, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/intake/confirm-action";
import { Button } from "@/components/ui/button";
import { Field, FormAlert, Input, Select, Textarea } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import {
  createSnippetAction,
  deleteSnippetAction,
  updateSnippetAction,
  type SnippetActionResult,
} from "@/lib/snippets/actions";
import {
  SNIPPET_BODY_MAX_LENGTH,
  SNIPPET_KINDS,
  SNIPPET_KIND_LABELS,
  SNIPPET_KIND_WITH_VARIABLES,
  SNIPPET_VARIABLES,
  SNIPPET_VARIABLE_LABELS,
  isSnippetKind,
  snippetLength,
  variableToken,
  type SnippetKind,
  type SnippetVariable,
} from "@/lib/snippets/model";
import { SNIPPET_PREVIEW_VALUES, checkSnippetEmailFormat } from "@/lib/snippets/preview";
import {
  KIND_REQUIRED_MESSAGE,
  checkKindRules,
  snippetBodySchema,
  snippetNameSchema,
} from "@/lib/snippets/schemas";
import { cn } from "@/lib/utils";

/** Un texto guardado, tal como llega a la pantalla de editar. */
export type EditableSnippet = {
  id: string;
  kind: SnippetKind;
  name: string;
  body: string;
  isDefault: boolean;
  revision: number;
};

type Props = {
  tenantId: string;
  /** Adónde se vuelve al terminar (la lista de textos o, en el futuro, el paso del onboarding). */
  listHref: string;
} & (
  | {
      mode: "create";
      /** Lo genera la pantalla al abrir «nuevo»: así un doble clic no crea dos textos. */
      snippetId: string;
    }
  | { mode: "edit"; snippet: EditableSnippet }
);

type FieldErrors = Partial<Record<"kind" | "name" | "body" | "isDefault", string>>;

const KIND_HINTS: Readonly<Record<SnippetKind, string>> = {
  email_body: "Pensado para el mensaje que acompaña la cotización cuando la envías.",
  conditions: "Plazos, forma de pago y otras condiciones de la oferta.",
  exclusions: "Lo que no incluye la cotización, por ejemplo «No incluye embalaje».",
  footer_note: "Pensado para las notas del final del documento.",
};

const FORM_FIELDS = ["kind", "name", "body", "isDefault"] as const;
const RESULT_TOAST_ID = "snippet-result";
const NETWORK_FAILURE_MESSAGE =
  "No pudimos conectar con el servidor. Revisa tu conexión: lo que escribiste sigue aquí. Inténtalo de nuevo.";

/**
 * Formulario de un texto guardado (H-048a): tipo (solo al crear), nombre y texto con contador. Solo para el
 * texto del correo: botones que insertan las variables donde está el cursor, vista previa con datos de ejemplo y
 * la casilla «Usar como texto inicial del correo». Al editar, se puede eliminar.
 *
 * Es reutilizable (el onboarding lo usará en H-101). Quién puede usarlo lo decide el servidor en cada acción; esta
 * pantalla solo se muestra a quien administra los textos. Un fallo de red se muestra aquí mismo, sin perder lo escrito.
 */
export function SnippetForm(props: Props) {
  const { tenantId, listHref } = props;
  const router = useRouter();
  const editing = props.mode === "edit" ? props.snippet : null;
  const snippetId = props.mode === "edit" ? props.snippet.id : props.snippetId;

  const [kind, setKind] = useState<SnippetKind | "">(editing?.kind ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [body, setBody] = useState(editing?.body ?? "");
  const [isDefault, setIsDefault] = useState(editing?.isDefault ?? false);
  const [revision, setRevision] = useState(editing?.revision ?? 1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const busy = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const counterId = useId();
  const defaultErrorId = useId();
  const caretRef = useRef<number | null>(null);

  const isEmail = kind === SNIPPET_KIND_WITH_VARIABLES;
  const length = snippetLength(body);
  const overLimit = length > SNIPPET_BODY_MAX_LENGTH;

  // Tras insertar una variable, el cursor queda justo después de ella.
  useEffect(() => {
    const caret = caretRef.current;
    const textarea = textareaRef.current;
    if (caret === null || !textarea) return;
    caretRef.current = null;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }, [body]);

  function insertVariable(variable: SnippetVariable) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? body.length;
    const end = textarea?.selectionEnd ?? body.length;
    const token = variableToken(variable);
    caretRef.current = start + token.length;
    setBody(`${body.slice(0, start)}${token}${body.slice(end)}`);
    setFieldErrors((current) => ({ ...current, body: undefined }));
  }

  function changeKind(next: string) {
    const valid = isSnippetKind(next) ? next : "";
    setKind(valid);
    // Solo el texto del correo puede ser el texto inicial.
    if (valid !== SNIPPET_KIND_WITH_VARIABLES) setIsDefault(false);
    setFieldErrors((current) => ({ ...current, kind: undefined, isDefault: undefined }));
  }

  /**
   * Lo mismo que revisa el servidor (incluido que el correo se pueda enviar), para avisar sin ir y volver. El
   * servidor y la base lo vuelven a exigir: es el servidor el que manda.
   */
  function validateLocally(): FieldErrors {
    const errors: FieldErrors = {};
    if (kind === "") errors.kind = KIND_REQUIRED_MESSAGE;
    const nameCheck = snippetNameSchema.safeParse(name);
    if (!nameCheck.success) errors.name = nameCheck.error.issues[0]?.message;
    const bodyCheck = snippetBodySchema.safeParse(body);
    if (!bodyCheck.success) errors.body = bodyCheck.error.issues[0]?.message;
    if (kind !== "" && bodyCheck.success) {
      const problem = checkKindRules(kind, { body: bodyCheck.data, isDefault });
      if (problem) errors[problem.path] = problem.message;
    }
    return errors;
  }

  function applyFailure(result: Extract<SnippetActionResult, { status: "error" }>) {
    const fields: FieldErrors = result.fieldErrors ?? {};
    setFieldErrors(fields);
    // Un problema de un campo del formulario se muestra bajo ese campo; lo demás, arriba del formulario.
    const underAField = FORM_FIELDS.some((field) => fields[field]);
    setError(
      underAField ? null : { message: result.message, conflict: result.kind === "conflict" },
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const errors = validateLocally();
    setFieldErrors(errors);
    setError(null);
    if (Object.keys(errors).length > 0 || kind === "") return;

    busy.current = true;
    setPending(true);
    try {
      const result =
        props.mode === "create"
          ? await createSnippetAction(tenantId, { id: snippetId, kind, name, body, isDefault })
          : await updateSnippetAction(tenantId, {
              id: snippetId,
              expectedRevision: revision,
              name,
              body,
              isDefault,
            });
      if (result.status === "ok") {
        toast.success(result.message, { id: RESULT_TOAST_ID });
        if (props.mode === "create") {
          // Si ya existía, se lleva a ese texto para que la persona revise cómo quedó.
          router.push(
            result.outcome === "exists" && result.id ? `${listHref}/${result.id}` : listHref,
          );
          return;
        }
        if (result.revision) setRevision(result.revision);
        router.refresh();
      } else {
        applyFailure(result);
      }
    } catch {
      // Un fallo de red no puede tumbar la pantalla: se avisa aquí y lo escrito se conserva.
      setError({ message: NETWORK_FAILURE_MESSAGE, conflict: false });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function remove(): Promise<string | null> {
    try {
      const result = await deleteSnippetAction(tenantId, snippetId);
      if (result.status === "ok") {
        toast.success(result.message, { id: RESULT_TOAST_ID });
        router.push(listHref);
        return null;
      }
      return result.message;
    } catch {
      return NETWORK_FAILURE_MESSAGE;
    }
  }

  const preview = useMemo(() => {
    if (!isEmail) return null;
    if (body.trim() === "") return { state: "empty" as const };
    const formatted = checkSnippetEmailFormat(body);
    return formatted.ok
      ? { state: "ok" as const, text: formatted.text }
      : { state: "problem" as const, message: formatted.message };
  }, [body, isEmail]);

  return (
    <div className={cn("grid items-start gap-6", isEmail && "lg:grid-cols-[minmax(0,1fr)_26rem]")}>
      <form
        onSubmit={submit}
        noValidate
        data-testid="snippet-form"
        className="flex min-w-0 flex-col gap-5 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
      >
        <OfflineNotice />
        {error ? (
          <div className="flex flex-col gap-2" data-testid="snippet-error">
            <FormAlert>{error.message}</FormAlert>
            {error.conflict ? (
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid="snippet-reload"
                  onClick={() => router.refresh()}
                >
                  Recargar la versión actual
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {editing ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-fg">Tipo</p>
            <p data-testid="snippet-kind-fixed" className="text-fg">
              {SNIPPET_KIND_LABELS[editing.kind]}
            </p>
            <p className="text-sm text-fg-muted">
              El tipo no se puede cambiar. Si necesitas otro tipo, crea un texto nuevo.
            </p>
          </div>
        ) : (
          <Field
            label="Tipo de texto"
            error={fieldErrors.kind}
            hint={kind === "" ? "Elige para qué sirve este texto." : KIND_HINTS[kind]}
            required
          >
            {(control) => (
              <Select
                {...control}
                value={kind}
                onChange={(event) => changeKind(event.target.value)}
                data-testid="snippet-kind"
              >
                <option value="">Elige un tipo…</option>
                {SNIPPET_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {SNIPPET_KIND_LABELS[option]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        <Field
          label="Nombre"
          error={fieldErrors.name}
          hint="Así lo vas a reconocer en la lista, por ejemplo «Pago a 30 días»."
          required
        >
          {(control) => (
            <Input
              {...control}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setFieldErrors((current) => ({ ...current, name: undefined }));
              }}
              autoComplete="off"
              data-testid="snippet-name"
            />
          )}
        </Field>

        <div className="flex flex-col gap-2">
          <Field label="Texto" error={fieldErrors.body} required>
            {(control) => (
              <Textarea
                {...control}
                aria-describedby={[control["aria-describedby"], counterId]
                  .filter(Boolean)
                  .join(" ")}
                ref={textareaRef}
                value={body}
                onChange={(event) => {
                  setBody(event.target.value);
                  setFieldErrors((current) => ({ ...current, body: undefined }));
                }}
                rows={10}
                className="min-h-56"
                data-testid="snippet-body"
              />
            )}
          </Field>
          <p
            id={counterId}
            data-testid="snippet-counter"
            className={cn(
              "text-sm tabular-nums",
              overLimit ? "font-semibold text-danger" : "text-fg-muted",
            )}
          >
            {length.toLocaleString("es-CL")} / {SNIPPET_BODY_MAX_LENGTH.toLocaleString("es-CL")}
          </p>
          {/* Solo se anuncia al pasar el máximo (no con cada tecla). */}
          <span role="status" className="sr-only">
            {overLimit
              ? `Pasaste el máximo de ${SNIPPET_BODY_MAX_LENGTH.toLocaleString("es-CL")} caracteres.`
              : ""}
          </span>
        </div>

        {isEmail ? (
          <>
            <fieldset className="flex flex-col gap-2" data-testid="snippet-variables">
              <legend className="text-sm font-semibold text-fg">
                Datos que se completan solos
              </legend>
              <p className="text-sm text-fg-muted">
                Toca uno para ponerlo donde está el cursor. Pronto, cuando uses este texto al
                cotizar, se reemplazará por el dato real. Por ahora lo ves con datos de ejemplo en
                la vista previa.
              </p>
              <div className="flex flex-wrap gap-2">
                {SNIPPET_VARIABLES.map((variable) => (
                  <Button
                    key={variable}
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-testid={`snippet-variable-${variable}`}
                    onClick={() => insertVariable(variable)}
                  >
                    {SNIPPET_VARIABLE_LABELS[variable]}
                  </Button>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-col gap-1.5">
              <label
                className={cn(
                  "flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border-strong bg-surface p-3 transition-[border-color,background-color] duration-(--dur-fast) ease-ios hover:bg-surface-2",
                  "has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30",
                )}
              >
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(event) => setIsDefault(event.target.checked)}
                  aria-invalid={Boolean(fieldErrors.isDefault)}
                  aria-describedby={fieldErrors.isDefault ? defaultErrorId : undefined}
                  className="mt-0.5 size-5 shrink-0 accent-(--accent)"
                  data-testid="snippet-default"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-semibold text-fg">Usar como texto inicial del correo</span>
                  <span className="text-sm text-fg-muted">
                    Pronto, al enviar una cotización, el correo podrá partir con este texto. Solo
                    uno puede ser el inicial: si marcas este, se desmarca el anterior.
                  </span>
                </span>
              </label>
              {fieldErrors.isDefault ? (
                <p id={defaultErrorId} role="alert" className="text-sm text-danger">
                  {fieldErrors.isDefault}
                </p>
              ) : null}
            </div>
          </>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-2 sm:flex-row">
            {editing ? (
              <ConfirmAction
                testId="snippet-delete"
                trigger={
                  <Button type="button" variant="ghost" data-testid="snippet-delete-button">
                    <Trash2 aria-hidden />
                    Eliminar texto
                  </Button>
                }
                title="¿Eliminar este texto?"
                description="Las cotizaciones ya creadas no cambian."
                confirmLabel="Sí, eliminar"
                pendingLabel="Eliminando…"
                onConfirm={remove}
              />
            ) : null}
          </div>
          <Button
            type="submit"
            size="lg"
            disabled={pending}
            aria-disabled={pending}
            data-testid="snippet-save"
          >
            {pending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                Guardando…
              </>
            ) : (
              <>
                <Save aria-hidden />
                {editing ? "Guardar cambios" : "Guardar texto"}
              </>
            )}
          </Button>
        </div>
      </form>

      {isEmail && preview ? (
        <aside
          aria-label="Vista previa del texto"
          data-testid="snippet-preview"
          className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-6"
        >
          <h2 className="text-lg">Así se verá</h2>
          <p className="text-sm text-fg-muted">
            Con datos de ejemplo ({SNIPPET_PREVIEW_VALUES.cliente}, {SNIPPET_PREVIEW_VALUES.numero},{" "}
            {SNIPPET_PREVIEW_VALUES.remitente} y {SNIPPET_PREVIEW_VALUES.organizacion}). Los enlaces
            se muestran con su dirección.
          </p>
          <div className="rounded-lg border border-border bg-surface-2 p-4">
            {preview.state === "empty" ? (
              <p className="text-fg-muted">Escribe el texto para ver cómo quedará.</p>
            ) : preview.state === "problem" ? (
              <p data-testid="snippet-preview-problem" className="text-sm text-danger">
                {preview.message}
              </p>
            ) : (
              <p
                data-testid="snippet-preview-text"
                className="break-words whitespace-pre-wrap text-fg"
              >
                {preview.text}
              </p>
            )}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
