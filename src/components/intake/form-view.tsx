import type { CSSProperties } from "react";
import { Input, Textarea } from "@/components/ui/form-controls";
import type { FieldMode, FieldModes, QuantityMode } from "@/lib/intake/field-modes";
import { itemUnitShort } from "@/lib/intake/builder-model";
import { brandStyle } from "@/lib/share/brand-vars";
import type { PdfBrand } from "@/lib/pdf/types";
import { cn } from "@/lib/utils";

/**
 * El formulario público tal como lo ve quien pide una cotización. Es PRESENTACIONAL: lo usan la vista
 * previa del constructor (H-086, sin enviar nada) y, más adelante, la página pública (H-087).
 *
 * Manda la marca de la organización (`brandStyle` y `.customer-light`), nunca el diseño de Cotiza
 * Prime. No importa nada de dinero y no tiene dónde mostrar un monto: solo textos.
 */

export type FormViewItem = {
  id: string;
  publicName: string;
  publicDescription?: string | null;
  unit: string;
  quantityMode: QuantityMode;
};

export type FormViewProps = {
  brand: PdfBrand;
  organizationName: string;
  /** Logo ya resuelto (dirección de la aplicación o `data:`); `null` si no hay. */
  logoSrc: string | null;
  title: string;
  intro: string;
  fields: FieldModes;
  items: readonly FormViewItem[];
  /** Texto exacto del aviso de privacidad (`consent-notice.ts`), o `null` si todavía no se puede armar. */
  consentText: string | null;
  /** Política de privacidad propia de la organización (solo https), si la tiene. */
  privacyPolicyUrl: string | null;
  /** Vista previa: nada se puede escribir ni enviar. */
  preview?: boolean;
  /** Nivel del título (1 en la página pública, 3 dentro de otra pantalla). */
  headingLevel?: 1 | 2 | 3;
  /** Distingue los `id` si hay dos formularios en la misma pantalla. */
  idPrefix?: string;
};

const BRAND_BG = "bg-[var(--brand)] text-[var(--on-brand)]";
const BRAND_TEXT = "text-[var(--brand-text)]";
const LABEL = "text-sm font-semibold text-fg";

function requirement(mode: FieldMode | "required"): string {
  return mode === "optional" ? " (opcional)" : "";
}

function TextField({
  id,
  label,
  mode,
  type = "text",
  autoComplete,
  disabled,
}: {
  id: string;
  label: string;
  mode: FieldMode | "required";
  type?: string;
  autoComplete?: string;
  disabled: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={LABEL}>
        {label}
        {requirement(mode)}
        {mode === "required" ? (
          <span aria-hidden className="text-danger">
            {" "}
            *
          </span>
        ) : null}
      </label>
      <Input
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        disabled={disabled}
        required={mode === "required"}
      />
    </div>
  );
}

export function FormView({
  brand,
  organizationName,
  logoSrc,
  title,
  intro,
  fields,
  items,
  consentText,
  privacyPolicyUrl,
  preview = false,
  headingLevel = 2,
  idPrefix = "fv",
}: FormViewProps) {
  const Heading = `h${headingLevel}` as "h1" | "h2" | "h3";
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <div
      className="customer-light overflow-hidden rounded-lg border border-border shadow-2"
      style={brandStyle(brand) as CSSProperties}
      data-testid="form-view"
    >
      <header className={cn("flex min-w-0 items-center gap-3 p-4 sm:p-6", BRAND_BG)}>
        {logoSrc ? (
          // Logo de la organización: una dirección de la aplicación o `data:` (no se descarga de afuera).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoSrc}
            alt={`Logo de ${organizationName}`}
            className="max-h-12 max-w-32 shrink-0 rounded-xs bg-surface object-contain p-1"
          />
        ) : null}
        <p className="min-w-0 text-lg font-semibold break-words">{organizationName}</p>
      </header>

      {/* En la vista previa no se puede escribir ni tabular: `inert` lo saca también del orden de lectura. */}
      <form
        className="flex flex-col gap-6 bg-surface p-4 sm:p-6"
        noValidate
        {...(preview ? { inert: true } : {})}
      >
        <div className="flex min-w-0 flex-col gap-2">
          <Heading className="text-xl font-semibold break-words">{title}</Heading>
          {intro ? <p className="break-words whitespace-pre-line text-fg-muted">{intro}</p> : null}
        </div>

        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend className={cn("mb-1 text-xs tracking-[0.08em] uppercase", BRAND_TEXT)}>
            Qué necesitas
          </legend>
          {items.length === 0 ? (
            <p className="text-sm text-fg-muted">
              Aquí aparecerán los servicios que se puedan pedir.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((item) => {
                const unit = itemUnitShort(item.unit);
                return (
                  <li
                    key={item.id}
                    className="flex min-w-0 flex-col gap-2 rounded-md border border-border-strong p-3"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <input
                        id={id(`item-${item.id}`)}
                        type="checkbox"
                        disabled={preview}
                        className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
                      />
                      <label htmlFor={id(`item-${item.id}`)} className="min-w-0 flex-1">
                        <span className="block font-semibold break-words text-fg">
                          {item.publicName || "Servicio sin nombre"}
                        </span>
                        {item.publicDescription ? (
                          <span className="block text-sm break-words text-fg-muted">
                            {item.publicDescription}
                          </span>
                        ) : null}
                      </label>
                    </div>
                    {item.quantityMode !== "none" ? (
                      <div className="flex items-center gap-2 pl-8">
                        <label htmlFor={id(`qty-${item.id}`)} className="text-sm text-fg-muted">
                          Cantidad{requirement(item.quantityMode)}
                        </label>
                        <Input
                          id={id(`qty-${item.id}`)}
                          inputMode="decimal"
                          disabled={preview}
                          className="w-24"
                        />
                        {unit ? <span className="text-sm text-fg-muted">{unit}</span> : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-4">
          <legend className={cn("mb-1 text-xs tracking-[0.08em] uppercase", BRAND_TEXT)}>
            Tus datos
          </legend>
          <TextField
            id={id("name")}
            label="Nombre"
            mode="required"
            autoComplete="name"
            disabled={preview}
          />
          <TextField
            id={id("email")}
            label="Correo"
            mode="required"
            type="email"
            autoComplete="email"
            disabled={preview}
          />
          {fields.phone !== "off" ? (
            <TextField
              id={id("phone")}
              label="Teléfono"
              mode={fields.phone}
              type="tel"
              autoComplete="tel"
              disabled={preview}
            />
          ) : null}
          {fields.company !== "off" ? (
            <TextField
              id={id("company")}
              label="Empresa"
              mode={fields.company}
              autoComplete="organization"
              disabled={preview}
            />
          ) : null}
          {fields.comuna !== "off" ? (
            <TextField id={id("comuna")} label="Comuna" mode={fields.comuna} disabled={preview} />
          ) : null}
          {fields.serviceAddress !== "off" ? (
            <TextField
              id={id("address")}
              label="Dirección del servicio"
              mode={fields.serviceAddress}
              disabled={preview}
            />
          ) : null}
          {fields.desiredDate !== "off" ? (
            <TextField
              id={id("date")}
              label="Fecha deseada"
              mode={fields.desiredDate}
              type="date"
              disabled={preview}
            />
          ) : null}
          {fields.message !== "off" ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={id("message")} className={LABEL}>
                Mensaje{requirement(fields.message)}
                {fields.message === "required" ? (
                  <span aria-hidden className="text-danger">
                    {" "}
                    *
                  </span>
                ) : null}
              </label>
              <Textarea id={id("message")} name={id("message")} disabled={preview} />
            </div>
          ) : null}
        </fieldset>

        <div className="flex min-w-0 flex-col gap-3 rounded-md bg-surface-2 p-3 sm:p-4">
          <div className="flex min-w-0 items-start gap-3">
            <input
              id={id("consent")}
              type="checkbox"
              disabled={preview}
              className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
            />
            <label htmlFor={id("consent")} className="min-w-0 text-sm break-words text-fg">
              {consentText ??
                "El aviso de privacidad aparecerá aquí cuando tu organización tenga un correo de contacto."}
              {privacyPolicyUrl ? (
                <>
                  {" "}
                  <a
                    href={privacyPolicyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn("font-semibold underline", BRAND_TEXT)}
                  >
                    Leer la política de privacidad
                  </a>
                  .
                </>
              ) : null}
            </label>
          </div>
        </div>

        <button
          type="button"
          disabled={preview}
          className={cn(
            "inline-flex h-12 w-full items-center justify-center rounded-sm px-5 text-base font-semibold shadow-1 disabled:opacity-100",
            BRAND_BG,
          )}
        >
          Enviar solicitud
        </button>
      </form>
    </div>
  );
}
