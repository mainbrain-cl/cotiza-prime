"use client";

import { useActionState, useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { useResultToast } from "@/components/ui/use-result-toast";
import {
  previewNumberingAction,
  saveNumberingAction,
  type NumberingPreview,
} from "@/lib/numbering/actions";
import type { NumberingMode } from "@/lib/numbering/format";
import { INITIAL_NUMBERING_STATE } from "@/lib/numbering/form-state";
import { PREFIX_MAX_LENGTH } from "@/lib/numbering/schemas";
import { cn } from "@/lib/utils";

const PREVIEW_DELAY_MS = 300;

const MODE_OPTIONS: readonly { value: NumberingMode; title: string; example: string }[] = [
  { value: "yearly", title: "Se reinicia cada año", example: "COT-2026-0043" },
  { value: "continuous", title: "Corrido, nunca se reinicia", example: "COT-2043" },
];

type PreviewEntry = { key: string; result: NumberingPreview };

export function NumberingForm({
  tenantId,
  initial,
  canEdit,
}: {
  tenantId: string;
  initial: { prefix: string; mode: NumberingMode; startNumber: number };
  canEdit: boolean;
}) {
  const [state, formAction] = useActionState(
    saveNumberingAction.bind(null, tenantId),
    INITIAL_NUMBERING_STATE,
  );
  useResultToast(state, {
    successMessage: `Guardamos tu numeración. La próxima cotización será ${state.savedPreview}.`,
  });
  const [prefix, setPrefix] = useState(initial.prefix);
  const [mode, setMode] = useState<NumberingMode>(initial.mode);
  const [startNumber, setStartNumber] = useState(String(initial.startNumber));
  const [entry, setEntry] = useState<PreviewEntry | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  const key = `${prefix}|${mode}|${startNumber}`;

  // La vista previa la calcula el servidor; se pide poco después de dejar de escribir.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await previewNumberingAction(tenantId, { prefix, mode, startNumber });
        if (!cancelled) setEntry({ key, result });
      } catch {
        if (!cancelled) setFailedKey(key);
      }
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tenantId, prefix, mode, startNumber, key]);

  const loading = entry?.key !== key && failedKey !== key;
  const current = entry?.key === key ? entry.result : null;
  const previewFailed = failedKey === key;

  const serverErrors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  const liveErrors = current && !current.ok ? current.fieldErrors : {};
  const errors = { ...serverErrors, ...liveErrors };
  const saved = state.status === "saved" && state.values && !loading;
  const showSaved =
    saved &&
    state.values?.prefix === prefix &&
    state.values?.mode === mode &&
    state.values?.startNumber === startNumber;

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      <OfflineNotice />
      {state.status === "error" && state.message ? <FormAlert>{state.message}</FormAlert> : null}
      {showSaved ? (
        <FormAlert tone="success" silent>
          <span className="inline-flex items-center gap-2" data-testid="numbering-saved">
            <CheckCircle2 aria-hidden className="size-4" />
            Guardamos tu numeración. La próxima cotización será {state.savedPreview}.
          </span>
        </FormAlert>
      ) : null}

      <Field
        label="Prefijo"
        error={errors.prefix}
        hint={`Hasta ${PREFIX_MAX_LENGTH} letras o números. Por ejemplo COT, PRES o PPTO.`}
        required
      >
        {(control) => (
          <Input
            {...control}
            name="prefix"
            value={prefix}
            onChange={(event) => setPrefix(event.target.value.toUpperCase())}
            maxLength={PREFIX_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            disabled={!canEdit}
            required
          />
        )}
      </Field>

      <fieldset className="flex flex-col gap-2" disabled={!canEdit}>
        <legend className="mb-1.5 text-sm font-semibold text-fg">Formato del correlativo</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {MODE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={cn(
                "relative flex min-h-11 cursor-pointer flex-col gap-0.5 rounded-md border bg-surface px-4 py-3 shadow-1 transition-[border-color,box-shadow] duration-(--dur-fast) ease-ios has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30",
                mode === option.value
                  ? "border-accent bg-accent-soft"
                  : "border-border-strong hover:border-accent",
              )}
            >
              <input
                type="radio"
                name="mode"
                value={option.value}
                checked={mode === option.value}
                onChange={() => setMode(option.value)}
                className="peer absolute inset-0 size-full cursor-[inherit] appearance-none rounded-md outline-none"
              />
              {mode === option.value ? (
                <CheckCircle2
                  aria-hidden
                  data-testid="numbering-mode-selected"
                  className="absolute top-3 right-3 size-5 text-accent"
                />
              ) : null}
              <span className="pr-8 text-sm font-semibold text-fg">{option.title}</span>
              <span className="text-sm text-fg-muted">
                Ejemplo: <span className="font-mono">{option.example}</span>
              </span>
            </label>
          ))}
        </div>
        {errors.mode ? (
          <p role="alert" className="text-sm text-danger">
            {errors.mode}
          </p>
        ) : null}
      </fieldset>

      <Field
        label="Número de la próxima cotización"
        error={errors.startNumber}
        hint="Si ya llevas cotizaciones hechas a mano, parte desde donde quedaste, por ejemplo 2001. Nunca puede ser menor que el último número usado."
        required
      >
        {(control) => (
          <Input
            {...control}
            name="startNumber"
            value={startNumber}
            onChange={(event) => setStartNumber(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            disabled={!canEdit}
            required
          />
        )}
      </Field>

      <section
        aria-labelledby="numbering-preview-title"
        className="flex flex-col gap-1 rounded-lg border border-border bg-surface-2 px-4 py-4"
      >
        <h2 id="numbering-preview-title" className="text-sm font-semibold text-fg-muted">
          Así se verá tu próxima cotización
        </h2>
        <p
          aria-live="polite"
          data-testid="numbering-preview"
          className="min-h-9 font-mono text-2xl font-semibold text-fg"
        >
          {loading ? (
            <span className="inline-flex items-center gap-2 text-base font-normal text-fg-muted">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Calculando…
            </span>
          ) : previewFailed ? (
            <span className="text-base font-normal text-danger">
              No pudimos calcular el ejemplo. Revisa tu conexión.
            </span>
          ) : current?.ok ? (
            current.preview
          ) : (
            <span className="text-base font-normal text-fg-muted">
              Corrige los datos para ver el ejemplo.
            </span>
          )}
        </p>
      </section>

      {canEdit ? (
        <div>
          <SubmitButton pendingLabel="Guardando…">Guardar numeración</SubmitButton>
        </div>
      ) : (
        <FormAlert tone="warning">
          Solo el Dueño o un Administrador puede cambiar la numeración.
        </FormAlert>
      )}
    </form>
  );
}
