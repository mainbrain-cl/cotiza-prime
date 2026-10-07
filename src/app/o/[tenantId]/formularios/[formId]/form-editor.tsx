"use client";

import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CircleCheck,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Archive,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/intake/confirm-action";
import { CopyLinkButton } from "@/components/intake/copy-link-button";
import { FormStatusBadge } from "@/components/intake/form-status-badge";
import { FormView } from "@/components/intake/form-view";
import { Button } from "@/components/ui/button";
import { Field, FormAlert, Input, Select, Textarea } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import {
  regenerateIntakeFormLinkAction,
  saveIntakeFormAction,
  setIntakeFormStatusAction,
  type BuilderResult,
} from "@/lib/intake/builder-actions";
import {
  CONFIGURABLE_FIELDS,
  FIELD_MODE_OPTIONS,
  FORM_INTRO_MAX,
  FORM_ITEM_DESCRIPTION_MAX,
  FORM_ITEM_NAME_MAX,
  FORM_ITEMS_MAX,
  FORM_NAME_MAX,
  FORM_SUCCESS_MAX,
  FORM_TITLE_MAX,
  ITEM_UNITS,
  PRICE_WARNING,
  QUANTITY_MODE_OPTIONS,
  SUGGESTED_FIELD_MODES,
  freeItem,
  isSuggestedMode,
  itemFromCatalog,
  looksLikePrice,
  moveItem,
  type CatalogChoice,
  type EditorForm,
  type FormStatus,
} from "@/lib/intake/builder-model";
import { isValidPolicyUrl, validateEditorForm } from "@/lib/intake/builder-schema";
import type { FieldMode, FieldModes, QuantityMode } from "@/lib/intake/field-modes";
import type { PdfBrand } from "@/lib/pdf/types";
import { cn } from "@/lib/utils";
import { SuccessPreview } from "./success-preview";

type FormEditorProps = {
  tenantId: string;
  formId: string;
  canEdit: boolean;
  initialRevision: number;
  initialStatus: FormStatus;
  initialPublicUrl: string | null;
  initialForm: EditorForm;
  catalog: CatalogChoice[];
  brand: PdfBrand;
  organizationName: string;
  logoSrc: string | null;
  consentText: string | null;
  hasContactEmail: boolean;
  contactSettingsHref: string;
};

const SAVED_TOAST_ID = "intake-form-saved";
const LIVE_NEEDS_ITEM_MESSAGE =
  "Un formulario publicado necesita al menos un servicio. Agrega uno o pausa el formulario antes de quitar el último.";
const OFFLINE_MESSAGE =
  "No pudimos comunicarnos con el servidor. Revisa tu conexión; lo que escribiste sigue aquí.";

/** Aviso que no bloquea: el texto parece traer un precio y lo verá cualquiera. */
function PriceWarning({ text }: { text: string }) {
  if (!looksLikePrice(text)) return null;
  return (
    <p
      role="status"
      data-testid="price-warning"
      className="flex items-start gap-2 rounded-sm bg-warning-soft px-3 py-2 text-sm font-medium text-warning"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      {PRICE_WARNING}
    </p>
  );
}

function Section({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-lg">{title}</h2>
        {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function FormEditor({
  tenantId,
  formId,
  canEdit,
  initialRevision,
  initialStatus,
  initialPublicUrl,
  initialForm,
  catalog,
  brand,
  organizationName,
  logoSrc,
  consentText,
  hasContactEmail,
  contactSettingsHref,
}: FormEditorProps) {
  const [form, setForm] = useState<EditorForm>(initialForm);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(initialForm));
  const [revision, setRevision] = useState(initialRevision);
  const [status, setStatus] = useState<FormStatus>(initialStatus);
  const [publicUrl, setPublicUrl] = useState<string | null>(initialPublicUrl);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{
    message: string;
    fixHref?: string;
    fixLabel?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState(false);
  const [catalogPick, setCatalogPick] = useState("");
  const [previewTab, setPreviewTab] = useState<"form" | "sent">("form");
  const [moveNote, setMoveNote] = useState("");
  const [errorFocusTick, setErrorFocusTick] = useState(0);
  const editorRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ id: string; dir: "up" | "down" } | null>(null);

  const dirty = useMemo(() => JSON.stringify(form) !== savedSnapshot, [form, savedSnapshot]);
  const archived = status === "archived";
  const editable = canEdit && !archived;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Tras un error al guardar, el foco va al primer campo con error (el aviso solo no alcanza con teclado).
  useEffect(() => {
    if (errorFocusTick === 0) return;
    editorRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errorFocusTick]);

  // Tras subir o bajar un servicio, el foco sigue al servicio movido.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const same = document.getElementById(
      `move-${target.dir}-${target.id}`,
    ) as HTMLButtonElement | null;
    const other = document.getElementById(
      `move-${target.dir === "up" ? "down" : "up"}-${target.id}`,
    ) as HTMLButtonElement | null;
    (same && !same.disabled ? same : other)?.focus();
  }, [form.items]);

  const usedCatalogIds = new Set(form.items.map((item) => item.catalogItemId));
  const availableCatalog = catalog.filter((choice) => !usedCatalogIds.has(choice.id));

  function patch(partial: Partial<EditorForm>) {
    setForm((current) => ({ ...current, ...partial }));
  }

  function setFieldMode(key: keyof FieldModes, mode: FieldMode) {
    setForm((current) => ({ ...current, fields: { ...current.fields, [key]: mode } }));
  }

  function patchItem(index: number, partial: Partial<EditorForm["items"][number]>) {
    setForm((current) => ({
      ...current,
      items: current.items.map((item, i) => (i === index ? { ...item, ...partial } : item)),
    }));
  }

  function move(index: number, delta: -1 | 1) {
    const item = form.items[index];
    if (!item) return;
    pendingFocus.current = { id: item.id, dir: delta === -1 ? "up" : "down" };
    setMoveNote(`Movido al puesto ${index + delta + 1} de ${form.items.length}`);
    patch({ items: moveItem(form.items, index, delta) });
  }

  function addFromCatalog() {
    const choice = catalog.find((c) => c.id === catalogPick);
    if (!choice || form.items.length >= FORM_ITEMS_MAX) return;
    patch({ items: [...form.items, itemFromCatalog(choice, crypto.randomUUID())] });
    setCatalogPick("");
  }

  function addFreeItem() {
    if (form.items.length >= FORM_ITEMS_MAX) return;
    patch({ items: [...form.items, freeItem(crypto.randomUUID())] });
  }

  function showFailure(result: Extract<BuilderResult, { status: "error" }>) {
    setBanner({ message: result.message, fixHref: result.fixHref, fixLabel: result.fixLabel });
    if (result.fieldErrors) {
      setErrors(result.fieldErrors);
      setErrorFocusTick((tick) => tick + 1);
    }
  }

  async function save() {
    if (saving || !editable) return;
    setBanner(null);
    const checked = validateEditorForm(form);
    const needsItem = (status === "published" || status === "paused") && form.items.length === 0;
    if (!checked.ok || needsItem) {
      setErrors({
        ...(checked.ok ? {} : checked.errors),
        ...(needsItem ? { items: LIVE_NEEDS_ITEM_MESSAGE } : {}),
      });
      setBanner({
        message: needsItem
          ? LIVE_NEEDS_ITEM_MESSAGE
          : "Revisa los campos marcados y vuelve a guardar.",
      });
      setErrorFocusTick((tick) => tick + 1);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const result = await saveIntakeFormAction(tenantId, formId, revision, form);
      if (result.status === "error") {
        showFailure(result);
        return;
      }
      if (typeof result.revision === "number") setRevision(result.revision);
      setSavedSnapshot(JSON.stringify(form));
      toast.success(result.message, { id: SAVED_TOAST_ID });
    } catch {
      setBanner({ message: OFFLINE_MESSAGE });
    } finally {
      setSaving(false);
    }
  }

  /** Cambia el estado. Devuelve el mensaje de error o `null`. */
  async function changeStatus(
    next: "published" | "paused" | "archived",
    resumed = false,
  ): Promise<string | null> {
    if (working) return null;
    setBanner(null);
    setWorking(true);
    try {
      const result = await setIntakeFormStatusAction(tenantId, formId, next, resumed);
      if (result.status === "error") {
        showFailure(result);
        return result.message;
      }
      if (result.formStatus) setStatus(result.formStatus);
      setPublicUrl(result.publicUrl ?? null);
      toast.success(result.message, { id: SAVED_TOAST_ID });
      return null;
    } catch {
      setBanner({ message: OFFLINE_MESSAGE });
      return OFFLINE_MESSAGE;
    } finally {
      setWorking(false);
    }
  }

  async function regenerate(): Promise<string | null> {
    setBanner(null);
    const result = await regenerateIntakeFormLinkAction(tenantId, formId);
    if (result.status === "error") {
      showFailure(result);
      return result.message;
    }
    setPublicUrl(result.publicUrl ?? null);
    toast.success(result.message, { id: SAVED_TOAST_ID });
    return null;
  }

  const hasItems = form.items.length > 0;
  const live = status === "published" || status === "paused";
  const canPublish = status === "draft" || status === "paused";

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem] 2xl:grid-cols-[minmax(0,1fr)_32rem]">
      <div ref={editorRef} className="flex min-w-0 flex-col gap-6">
        <p className="sr-only" aria-live="polite" data-testid="move-note">
          {moveNote}
        </p>
        <OfflineNotice />
        {banner ? (
          <FormAlert>
            {banner.message}
            {banner.fixHref ? (
              <>
                {" "}
                <Link href={banner.fixHref} className="font-semibold underline">
                  {banner.fixLabel ?? "Corregir"}
                </Link>
              </>
            ) : null}
          </FormAlert>
        ) : null}
        {!canEdit ? (
          <FormAlert tone="warning">
            Puedes ver este formulario, pero solo el Dueño y los Administradores pueden cambiarlo.
          </FormAlert>
        ) : null}
        {archived ? (
          <FormAlert tone="warning">
            Este formulario está archivado: ya no recibe solicitudes ni se puede cambiar.
          </FormAlert>
        ) : null}

        <fieldset disabled={!editable} className="flex min-w-0 flex-col gap-6">
          <Section
            title="Datos del formulario"
            description="El nombre interno es solo para ti. El título y la introducción los ve quien pide la cotización."
            testId="section-basics"
          >
            <Field label="Nombre interno" required error={errors.name}>
              {(control) => (
                <Input
                  {...control}
                  value={form.name}
                  maxLength={FORM_NAME_MAX}
                  onChange={(event) => patch({ name: event.target.value })}
                />
              )}
            </Field>
            <Field
              label="Título del formulario"
              required
              error={errors.title}
              hint="Lo primero que lee la persona. Por ejemplo: Pide tu cotización de flete."
            >
              {(control) => (
                <Input
                  {...control}
                  value={form.title}
                  maxLength={FORM_TITLE_MAX}
                  onChange={(event) => patch({ title: event.target.value })}
                />
              )}
            </Field>
            <Field
              label="Introducción (opcional)"
              error={errors.intro}
              hint="Una o dos frases para explicar qué pasa después de enviar."
            >
              {(control) => (
                <Textarea
                  {...control}
                  value={form.intro}
                  maxLength={FORM_INTRO_MAX}
                  onChange={(event) => patch({ intro: event.target.value })}
                />
              )}
            </Field>
            <Field
              label="Mensaje al enviar (opcional)"
              error={errors.successMessage}
              hint="Lo que verá la persona cuando su solicitud llegue. Por ejemplo: Gracias, te responderemos hoy."
            >
              {(control) => (
                <Textarea
                  {...control}
                  value={form.successMessage}
                  maxLength={FORM_SUCCESS_MAX}
                  onChange={(event) => patch({ successMessage: event.target.value })}
                />
              )}
            </Field>
          </Section>

          <Section
            title="Qué datos pides"
            description="El nombre y el correo siempre se piden y son obligatorios. Pide solo lo que necesitas para cotizar."
            testId="section-fields"
          >
            {editable ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="use-suggested"
                  onClick={() => patch({ fields: { ...SUGGESTED_FIELD_MODES } })}
                >
                  Usar lo mínimo sugerido
                </Button>
                <p className="min-w-0 flex-1 text-sm text-fg-muted">
                  Deja solo nombre y correo, más lo que recomendamos (marcado «Sugerido»).
                </p>
              </div>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              {CONFIGURABLE_FIELDS.map((field) => (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  {(control) => (
                    <Select
                      {...control}
                      value={form.fields[field.key]}
                      onChange={(event) => setFieldMode(field.key, event.target.value as FieldMode)}
                    >
                      {FIELD_MODE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                          {isSuggestedMode(field.key, option.value) ? " · Sugerido" : ""}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ))}
            </div>
            <div
              data-testid="rut-note"
              className="rounded-md bg-surface-2 p-3 text-sm text-fg-muted"
            >
              <p className="font-semibold text-fg">¿Y el RUT, o una pregunta propia?</p>
              <p>
                No se pueden pedir, y es a propósito: para recibir una solicitud no hace falta el
                RUT, y pedir datos de más va contra la ley de datos personales (Ley 21.719, que pide
                recoger solo lo necesario). El RUT lo pides después, al armar la cotización. Para
                todo lo demás, la persona puede escribir en el campo Mensaje.
              </p>
            </div>
          </Section>

          <Section
            title="Qué servicios se pueden pedir"
            description={`Elige del catálogo o escribe uno libre (hasta ${FORM_ITEMS_MAX}). Aquí no se muestran ni se copian precios: la persona solo dice qué necesita. Revisa que los textos copiados del catálogo no traigan un precio escrito.`}
            testId="section-items"
          >
            {form.items.length === 0 ? (
              <p
                data-testid="items-empty"
                className="rounded-md border border-dashed border-border-strong p-4 text-sm text-fg-muted"
              >
                Todavía no hay servicios. Agrega al menos uno para poder publicar.
              </p>
            ) : (
              <ol className="flex flex-col gap-3" aria-label="Servicios del formulario">
                {form.items.map((item, index) => {
                  const base = `items.${index}`;
                  return (
                    <li
                      key={item.id}
                      data-testid="form-item"
                      className="flex min-w-0 flex-col gap-3 rounded-md border border-border-strong p-3"
                    >
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <p className="text-xs font-semibold tracking-[0.08em] text-fg-subtle uppercase">
                          {item.kind === "catalog" ? "Del catálogo" : "Servicio libre"}
                        </p>
                        {editable ? (
                          <div className="flex shrink-0 gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              id={`move-up-${item.id}`}
                              aria-label={`Subir ${item.publicName || "servicio"}`}
                              disabled={index === 0}
                              onClick={() => move(index, -1)}
                            >
                              <ArrowUp aria-hidden />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              id={`move-down-${item.id}`}
                              aria-label={`Bajar ${item.publicName || "servicio"}`}
                              disabled={index === form.items.length - 1}
                              onClick={() => move(index, 1)}
                            >
                              <ArrowDown aria-hidden />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Quitar ${item.publicName || "servicio"}`}
                              onClick={() =>
                                patch({ items: form.items.filter((_, i) => i !== index) })
                              }
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </div>
                        ) : null}
                      </div>
                      <Field
                        label="Nombre que verá la persona"
                        required
                        error={errors[`${base}.publicName`]}
                      >
                        {(control) => (
                          <Input
                            {...control}
                            value={item.publicName}
                            maxLength={FORM_ITEM_NAME_MAX}
                            onChange={(event) =>
                              patchItem(index, { publicName: event.target.value })
                            }
                          />
                        )}
                      </Field>
                      <PriceWarning text={item.publicName} />
                      <Field
                        label="Descripción (opcional)"
                        error={errors[`${base}.publicDescription`]}
                      >
                        {(control) => (
                          <Textarea
                            {...control}
                            rows={2}
                            className="min-h-20"
                            value={item.publicDescription}
                            maxLength={FORM_ITEM_DESCRIPTION_MAX}
                            onChange={(event) =>
                              patchItem(index, { publicDescription: event.target.value })
                            }
                          />
                        )}
                      </Field>
                      <PriceWarning text={item.publicDescription} />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Unidad" error={errors[`${base}.unit`]}>
                          {(control) => (
                            <Select
                              {...control}
                              value={item.unit}
                              onChange={(event) =>
                                patchItem(index, {
                                  unit: event.target.value as EditorForm["items"][number]["unit"],
                                })
                              }
                            >
                              {ITEM_UNITS.map((unit) => (
                                <option key={unit.value} value={unit.value}>
                                  {unit.label}
                                </option>
                              ))}
                            </Select>
                          )}
                        </Field>
                        <Field label="Cantidad">
                          {(control) => (
                            <Select
                              {...control}
                              value={item.quantityMode}
                              onChange={(event) =>
                                patchItem(index, {
                                  quantityMode: event.target.value as QuantityMode,
                                })
                              }
                            >
                              {QUANTITY_MODE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </Select>
                          )}
                        </Field>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}

            {editable ? (
              <div className="flex min-w-0 flex-col gap-3">
                {catalog.length > 0 ? (
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
                    <Field label="Agregar del catálogo" className="min-w-0 flex-1">
                      {(control) => (
                        <Select
                          {...control}
                          value={catalogPick}
                          onChange={(event) => setCatalogPick(event.target.value)}
                        >
                          <option value="">
                            {availableCatalog.length === 0
                              ? "Ya agregaste todo el catálogo"
                              : "Elige un servicio…"}
                          </option>
                          {availableCatalog.map((choice) => (
                            <option key={choice.id} value={choice.id}>
                              {choice.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={catalogPick === "" || form.items.length >= FORM_ITEMS_MAX}
                      onClick={addFromCatalog}
                      data-testid="add-from-catalog"
                    >
                      <Plus aria-hidden />
                      Agregar
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-fg-muted">
                    Tu catálogo no tiene servicios activos. Puedes escribir servicios libres.
                  </p>
                )}
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={form.items.length >= FORM_ITEMS_MAX}
                    onClick={addFreeItem}
                    data-testid="add-free-item"
                  >
                    <Plus aria-hidden />
                    Agregar un servicio libre
                  </Button>
                  {form.items.length >= FORM_ITEMS_MAX ? (
                    <p className="mt-2 text-sm text-fg-muted">
                      Llegaste al máximo de {FORM_ITEMS_MAX} servicios.
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-fg-subtle" data-testid="items-count">
                      {form.items.length} de {FORM_ITEMS_MAX} servicios
                    </p>
                  )}
                </div>
              </div>
            ) : null}
            {errors.items ? (
              <p role="alert" className="text-sm text-danger">
                {errors.items}
              </p>
            ) : null}
          </Section>

          <Section
            title="Política de privacidad (opcional)"
            description="Antes de enviar, la persona ve quién recibirá sus datos y para qué. Si tu empresa tiene su propia política, enlázala aquí."
            testId="section-privacy"
          >
            <Field
              label="Dirección de tu política de privacidad"
              error={errors.privacyPolicyUrl}
              hint="Debe empezar con https://. Si la dejas vacía, no se muestra ningún enlace."
            >
              {(control) => (
                <Input
                  {...control}
                  type="url"
                  inputMode="url"
                  placeholder="https://tuempresa.cl/privacidad"
                  value={form.privacyPolicyUrl}
                  onChange={(event) => patch({ privacyPolicyUrl: event.target.value })}
                />
              )}
            </Field>
          </Section>
        </fieldset>

        {editable ? (
          <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+6rem)] z-20 flex items-center justify-between gap-3 rounded-xl p-3 glass md:bottom-4">
            <p className="min-w-0 text-sm text-fg-muted" aria-live="polite">
              {dirty ? "Tienes cambios sin guardar." : "Todo guardado."}
            </p>
            <Button
              type="button"
              size="lg"
              onClick={() => void save()}
              disabled={saving || !dirty}
              aria-disabled={saving || !dirty}
              data-testid="save-form"
            >
              {saving ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        ) : null}
      </div>

      <aside className="flex min-w-0 flex-col gap-6 xl:sticky xl:top-6">
        <section
          data-testid="status-panel"
          aria-labelledby="status-title"
          className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 id="status-title" className="text-lg">
              Estado y enlace
            </h2>
            <FormStatusBadge status={status} />
          </div>

          {live && publicUrl ? (
            <div className="flex min-w-0 flex-col gap-2">
              <p className="text-sm font-semibold text-fg">Enlace público</p>
              <p
                data-testid="public-link"
                className="rounded-sm bg-surface-2 px-3 py-2 font-mono text-sm break-all text-fg"
              >
                {publicUrl}
              </p>
              <div className="flex flex-wrap gap-2">
                <CopyLinkButton url={publicUrl} />
              </div>
              {status === "paused" ? (
                <p className="text-sm text-fg-muted">
                  El formulario está en pausa: quien abra el enlace verá que por ahora no recibe
                  solicitudes.
                </p>
              ) : null}
            </div>
          ) : null}

          {canPublish && editable ? (
            <div className="flex min-w-0 flex-col gap-2" data-testid="publish-checklist">
              <p className="text-sm font-semibold text-fg">Para publicar necesitas</p>
              <ul className="flex flex-col gap-1.5 text-sm">
                <li className="flex items-start gap-2">
                  {hasItems ? (
                    <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                  )}
                  <span className={hasItems ? "text-fg-muted" : "text-fg"}>
                    {hasItems
                      ? "Al menos un servicio que se pueda pedir"
                      : "Agregar al menos un servicio que se pueda pedir"}
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  {hasContactEmail ? (
                    <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                  )}
                  <span className={hasContactEmail ? "text-fg-muted" : "text-fg"}>
                    {hasContactEmail ? (
                      "Un correo de contacto de tu empresa"
                    ) : (
                      <>
                        Un correo de contacto de tu empresa.{" "}
                        <Link href={contactSettingsHref} className="font-semibold underline">
                          Agregarlo en Datos de tu empresa
                        </Link>
                      </>
                    )}
                  </span>
                </li>
              </ul>
            </div>
          ) : null}

          {editable ? (
            <div className="flex flex-wrap gap-2">
              {canPublish ? (
                <Button
                  type="button"
                  onClick={() => void changeStatus("published", status === "paused")}
                  disabled={working || dirty}
                  aria-disabled={working || dirty}
                  data-testid={status === "paused" ? "resume-form" : "publish-form"}
                >
                  {status === "paused" ? <Play aria-hidden /> : <Rocket aria-hidden />}
                  {status === "paused" ? "Reanudar" : "Publicar"}
                </Button>
              ) : null}
              {status === "published" ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void changeStatus("paused")}
                  disabled={working}
                  data-testid="pause-form"
                >
                  <Pause aria-hidden />
                  Pausar
                </Button>
              ) : null}
              {live ? (
                <ConfirmAction
                  testId="regenerate"
                  trigger={
                    <Button type="button" variant="secondary" disabled={working}>
                      <RefreshCw aria-hidden />
                      Crear enlace nuevo
                    </Button>
                  }
                  title="¿Crear un enlace nuevo?"
                  description="El enlace actual dejará de funcionar de inmediato: también los códigos QR impresos y los formularios pegados en una página web. Quien los use verá que el formulario no existe. Úsalo si te llegó basura o el enlace se difundió por error."
                  confirmLabel="Sí, crear enlace nuevo"
                  pendingLabel="Creando…"
                  onConfirm={regenerate}
                />
              ) : null}
              <ConfirmAction
                testId="archive"
                trigger={
                  <Button type="button" variant="ghost" disabled={working}>
                    <Archive aria-hidden />
                    Archivar
                  </Button>
                }
                title="¿Archivar este formulario?"
                description={`Dejará de recibir solicitudes y no se podrá volver a publicar. Las solicitudes que ya llegaron se conservan. Si solo quieres descansar un tiempo, usa Pausar.${dirty ? " Tienes cambios sin guardar: si archivas ahora, se perderán." : ""}`}
                confirmLabel="Sí, archivar"
                pendingLabel="Archivando…"
                onConfirm={() => changeStatus("archived")}
              />
            </div>
          ) : null}
          {dirty && editable && canPublish ? (
            <p className="text-sm text-fg-muted">Guarda los cambios antes de publicar.</p>
          ) : null}
        </section>

        <section aria-labelledby="preview-title" className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 id="preview-title" className="text-lg">
              Así se verá con tu marca
            </h2>
            <p className="text-sm text-fg-muted">
              Es una vista previa: no se envía nada. Se actualiza mientras escribes.
            </p>
          </div>
          <div role="group" aria-label="Qué parte ver" className="flex gap-2">
            {(
              [
                ["form", "Formulario"],
                ["sent", "Al enviar"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={previewTab === value}
                data-testid={`preview-tab-${value}`}
                onClick={() => setPreviewTab(value)}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/30 md:min-h-9",
                  previewTab === value
                    ? "border-accent bg-accent text-on-accent"
                    : "border-border-strong bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {previewTab === "form" ? (
            <FormView
              preview
              idPrefix="preview"
              headingLevel={3}
              brand={brand}
              organizationName={organizationName}
              logoSrc={logoSrc}
              title={form.title.trim() || "Título del formulario"}
              intro={form.intro.trim()}
              fields={form.fields}
              items={form.items}
              consentText={consentText}
              privacyPolicyUrl={
                form.privacyPolicyUrl.trim() !== "" && isValidPolicyUrl(form.privacyPolicyUrl)
                  ? form.privacyPolicyUrl.trim()
                  : null
              }
            />
          ) : (
            <SuccessPreview
              brand={brand}
              organizationName={organizationName}
              logoSrc={logoSrc}
              message={form.successMessage.trim()}
            />
          )}
        </section>
      </aside>
    </div>
  );
}
