"use client";

import { ImageUp, TriangleAlert } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { useResultToast } from "@/components/ui/use-result-toast";
import { saveBrandAction } from "@/lib/brand/actions";
import {
  contrastOnWhite,
  normalizeHexColor,
  readableTextOn,
  readsWellOnWhite,
  MIN_TEXT_CONTRAST,
} from "@/lib/brand/colors";
import { INITIAL_BRAND_STATE, type BrandSaveState } from "@/lib/brand/form-state";
import { LOGO_ACCEPT, LOGO_HELP, LOGO_MAX_BYTES, LOGO_TOO_BIG_MESSAGE } from "@/lib/brand/logo";
import { cn } from "@/lib/utils";

export type BrandFormInitial = {
  companyName: string;
  primaryColor: string;
  secondaryColor: string;
  /** Dirección del logo guardado, si hay uno. */
  logoUrl: string | null;
};

/** Tres decimales no aportan: 2,3:1 se lee mejor que 2,28:1. */
const formatRatio = (ratio: number) => ratio.toFixed(1).replace(".", ",");

export function BrandForm({
  tenantId,
  initial,
  canEdit,
}: {
  tenantId: string;
  initial: BrandFormInitial;
  canEdit: boolean;
}) {
  const [state, formAction] = useActionState(
    saveBrandAction.bind(null, tenantId),
    INITIAL_BRAND_STATE,
  );
  useResultToast(state, { successMessage: "Guardamos la marca de tu empresa." });

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      <OfflineNotice />
      {state.status === "error" && state.message ? <FormAlert>{state.message}</FormAlert> : null}

      {/* Al cambiar el logo guardado, los campos se arman de nuevo con lo recién guardado. */}
      <BrandFields
        key={initial.logoUrl ?? "sin-logo"}
        initial={initial}
        canEdit={canEdit}
        state={state}
      />

      {canEdit ? (
        <div>
          <SubmitButton pendingLabel="Guardando…">Guardar marca</SubmitButton>
        </div>
      ) : (
        <FormAlert tone="warning">
          Solo el Dueño o un Administrador puede cambiar la marca.
        </FormAlert>
      )}
    </form>
  );
}

function BrandFields({
  initial,
  canEdit,
  state,
}: {
  initial: BrandFormInitial;
  canEdit: boolean;
  state: BrandSaveState;
}) {
  const [primary, setPrimary] = useState(state.values?.primaryColor ?? initial.primaryColor);
  const [secondary, setSecondary] = useState(
    state.values?.secondaryColor ?? initial.secondaryColor,
  );
  const [removeLogo, setRemoveLogo] = useState(false);
  const [pickedUrl, setPickedUrl] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Libera la dirección temporal de la imagen elegida cuando cambia o se cierra la pantalla.
  useEffect(() => {
    return () => {
      if (pickedUrl) URL.revokeObjectURL(pickedUrl);
    };
  }, [pickedUrl]);

  const errors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  const logoError = clientError ?? errors.logo;
  const shownLogo = removeLogo ? null : (pickedUrl ?? initial.logoUrl);

  function onFileChange(file: File | undefined) {
    setClientError(null);
    setPickedUrl(null);
    if (!file) return;
    // Aviso inmediato; el servidor vuelve a revisar el tipo real y el tamaño.
    if (file.size > LOGO_MAX_BYTES) {
      setClientError(LOGO_TOO_BIG_MESSAGE);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setRemoveLogo(false);
    setPickedUrl(URL.createObjectURL(file));
  }

  return (
    <>
      <fieldset className="flex flex-col gap-4" disabled={!canEdit}>
        <legend className="mb-1 text-sm font-semibold text-fg">Logo</legend>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div
            data-testid="brand-logo-preview"
            className="flex h-24 w-40 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-surface p-2"
          >
            {shownLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={shownLogo}
                alt="Logo de tu empresa"
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <span className="flex flex-col items-center gap-1 text-xs text-fg-muted">
                <ImageUp aria-hidden strokeWidth={1.75} className="size-6" />
                Sin logo
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Field label="Archivo del logo" error={logoError} hint={LOGO_HELP}>
              {(control) => (
                <input
                  {...control}
                  ref={fileInput}
                  type="file"
                  name="logo"
                  accept={LOGO_ACCEPT}
                  onChange={(event) => onFileChange(event.target.files?.[0])}
                  className="min-h-11 w-full cursor-pointer rounded-sm border border-border-strong bg-surface text-sm text-fg shadow-1 outline-none file:mr-3 file:h-full file:cursor-pointer file:border-0 file:bg-accent-soft file:px-4 file:py-2.5 file:font-semibold file:text-accent focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50 aria-invalid:border-danger"
                />
              )}
            </Field>
            {initial.logoUrl && !pickedUrl ? (
              <label className="flex min-h-11 w-fit cursor-pointer items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  name="removeLogo"
                  value="1"
                  checked={removeLogo}
                  onChange={(event) => setRemoveLogo(event.target.checked)}
                  className="size-4 accent-(--accent)"
                />
                Quitar el logo actual
              </label>
            ) : null}
          </div>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2" disabled={!canEdit}>
        <legend className="mb-1 text-sm font-semibold text-fg">Colores</legend>
        <ColorField
          label="Color principal"
          name="primaryColor"
          value={primary}
          onChange={setPrimary}
          error={errors.primaryColor}
          testId="primary"
        />
        <ColorField
          label="Color secundario"
          name="secondaryColor"
          value={secondary}
          onChange={setSecondary}
          error={errors.secondaryColor}
          testId="secondary"
        />
      </fieldset>

      <BrandSample
        companyName={initial.companyName}
        logoUrl={shownLogo}
        primary={normalizeHexColor(primary) ?? initial.primaryColor}
        secondary={normalizeHexColor(secondary) ?? initial.secondaryColor}
      />
    </>
  );
}

function ColorField({
  label,
  name,
  value,
  onChange,
  error,
  testId,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  testId: string;
}) {
  const hex = normalizeHexColor(value);
  const invalidFormat = value.trim() !== "" && hex === null;
  const lowContrast = hex !== null && !readsWellOnWhite(hex);

  return (
    <div className="flex flex-col gap-2">
      <Field
        label={label}
        error={error ?? (invalidFormat ? "Usa el formato #2B54E0." : undefined)}
        required
      >
        {(control) => (
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label={`${label}: elegir del selector de colores`}
              value={hex ?? "#000000"}
              onChange={(event) => onChange(event.target.value)}
              className="size-11 shrink-0 cursor-pointer rounded-sm border border-border-strong bg-surface p-1 shadow-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50 md:size-10"
            />
            <Input
              {...control}
              name={name}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={7}
              className="font-mono uppercase"
              required
            />
          </div>
        )}
      </Field>
      {lowContrast && hex ? (
        <p
          role="status"
          data-testid={`contrast-warning-${testId}`}
          className="flex items-start gap-2 rounded-sm bg-warning-soft px-3 py-2 text-sm font-medium text-warning"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Este color se lee con dificultad sobre blanco (contraste{" "}
            {formatRatio(contrastOnWhite(hex))}
            :1; lo recomendado es {formatRatio(MIN_TEXT_CONTRAST)}:1 o más). Puedes guardarlo, pero
            elige uno más oscuro si lo usarás en textos.
          </span>
        </p>
      ) : null}
    </div>
  );
}

/** Muestra al instante cómo se verá la marca en lo que recibe el cliente. */
function BrandSample({
  companyName,
  logoUrl,
  primary,
  secondary,
}: {
  companyName: string;
  logoUrl: string | null;
  primary: string;
  secondary: string;
}) {
  return (
    <section aria-labelledby="brand-sample-title" className="flex flex-col gap-2">
      <h2 id="brand-sample-title" className="text-sm font-semibold text-fg-muted">
        Así se verá en tus cotizaciones
      </h2>
      <div
        data-testid="brand-sample"
        className="overflow-hidden rounded-lg border border-border bg-surface shadow-2"
      >
        <div className="h-2" style={{ backgroundColor: primary }} data-testid="brand-sample-bar" />
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex h-12 min-w-0 items-center gap-3">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt="" className="max-h-12 max-w-32 object-contain" />
              ) : null}
              <span className="truncate font-semibold text-fg">{companyName}</span>
            </div>
            <span className="shrink-0 text-sm font-semibold" style={{ color: secondary }}>
              COT-2026-0001
            </span>
          </div>
          <div className="flex items-end justify-between gap-4 border-t border-border pt-4">
            <div className="flex flex-col">
              <span className="text-sm text-fg-muted">Total</span>
              <span
                className={cn("text-2xl font-semibold")}
                style={{ color: secondary }}
                data-testid="brand-sample-total"
              >
                $1.190.000
              </span>
            </div>
            <span
              className="inline-flex min-h-11 items-center rounded-md px-4 text-sm font-semibold"
              style={{ backgroundColor: primary, color: readableTextOn(primary) }}
              data-testid="brand-sample-button"
            >
              Revisar y aceptar la cotización
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
