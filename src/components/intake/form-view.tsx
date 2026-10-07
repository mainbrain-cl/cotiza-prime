import { Loader2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Input, Textarea } from "@/components/ui/form-controls";
import type { FieldMode, FieldModes, QuantityMode } from "@/lib/intake/field-modes";
import { itemUnitShort } from "@/lib/intake/builder-model";
import { brandStyle } from "@/lib/share/brand-vars";
import type { PdfBrand } from "@/lib/pdf/types";
import { cn } from "@/lib/utils";
import { BRAND_BG, BrandHeader } from "./brand-header";

/**
 * El formulario público tal como lo ve quien pide una cotización. Es PRESENTACIONAL: lo usan la vista
 * previa del constructor (H-086, sin enviar nada) y la página pública (H-087, con `interaction`, que le
 * entrega los valores y los avisos de quien la maneja).
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

/** Datos de texto que se escriben en el formulario. */
export type TextFieldKey =
  "name" | "email" | "phone" | "company" | "comuna" | "serviceAddress" | "desiredDate" | "message";

/**
 * Modo «de verdad»: el formulario recibe y devuelve lo que la persona escribe. Los errores llevan estas
 * claves: el nombre del campo, `item:<id>` para un servicio, `items` (ningún servicio elegido) y `consent`.
 */
export type FormInteraction = {
  values: Record<TextFieldKey, string>;
  onValueChange: (key: TextFieldKey, value: string) => void;
  /** Servicio elegido -> cantidad escrita (vacía si no lleva). Estar en la lista es estar elegido. */
  picked: Record<string, string>;
  onToggleItem: (id: string, checked: boolean) => void;
  onQuantityChange: (id: string, value: string) => void;
  consent: boolean;
  onConsentChange: (checked: boolean) => void;
  errors: Record<string, string>;
  submitting: boolean;
  onSubmit: () => void;
  /** Va justo antes del botón de enviar: verificación anti-robot, campo trampa y avisos. */
  beforeSubmit?: ReactNode;
  /**
   * La página ya está lista (hidratada). Mientras no lo esté, y siempre que el navegador no ejecute
   * JavaScript, el botón queda desactivado: un envío «clásico» del navegador pondría los datos en la dirección
   * de la página (y de ahí en los registros del servidor y el historial).
   */
  ready: boolean;
  /**
   * Dirección que recibe el formulario si el navegador lo envía por su cuenta. Con `method="post"` y SIN
   * `name` en los campos, ese envío no lleva ningún dato; el servidor igual lo rechaza (solo acepta JSON).
   */
  action: string;
};

export type FormViewProps = {
  brand: PdfBrand;
  organizationName: string;
  /** Logo ya resuelto (dirección de la aplicación o `data:`); `null` si no hay. Se ignora si viene `header`. */
  logoSrc?: string | null;
  /**
   * Encabezado de la marca ya dibujado por quien arma la página (componente de servidor). Si no viene, se
   * dibuja con `logoSrc`.
   */
  header?: ReactNode;
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
  /** Si viene, el formulario funciona de verdad (página pública). */
  interaction?: FormInteraction;
};

const BRAND_TEXT = "text-[var(--brand-text)]";
const LABEL = "text-sm font-semibold text-fg";

function requirement(mode: FieldMode | "required"): string {
  return mode === "optional" ? " (opcional)" : "";
}

/** Segunda defensa: aunque la base y el editor ya lo exigen, aquí solo se dibuja un enlace `https://`. */
function httpsUrlOrNull(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}

function TextField({
  id,
  fieldKey,
  label,
  mode,
  type = "text",
  autoComplete,
  disabled,
  interaction,
}: {
  id: string;
  fieldKey: TextFieldKey;
  label: string;
  mode: FieldMode | "required";
  type?: string;
  autoComplete?: string;
  disabled: boolean;
  interaction?: FormInteraction;
}) {
  const error = interaction?.errors[fieldKey];
  const errorId = `${id}-error`;
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
        type={type}
        autoComplete={autoComplete}
        disabled={disabled}
        required={mode === "required"}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...(interaction
          ? {
              value: interaction.values[fieldKey],
              onChange: (event) => interaction.onValueChange(fieldKey, event.target.value),
            }
          : {})}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

export function FormView({
  brand,
  organizationName,
  logoSrc = null,
  header,
  title,
  intro,
  fields,
  items,
  consentText,
  privacyPolicyUrl,
  preview = false,
  headingLevel = 2,
  idPrefix = "fv",
  interaction,
}: FormViewProps) {
  const Heading = `h${headingLevel}` as "h1" | "h2" | "h3";
  const id = (name: string) => `${idPrefix}-${name}`;
  const locked = preview;
  const safePolicyUrl = httpsUrlOrNull(privacyPolicyUrl);

  return (
    <div
      className="customer-light overflow-hidden rounded-lg border border-border shadow-2"
      style={brandStyle(brand) as CSSProperties}
      data-testid="form-view"
    >
      {header ?? <BrandHeader organizationName={organizationName} logoSrc={logoSrc} />}

      {/* En la vista previa no se puede escribir ni tabular: `inert` lo saca también del orden de lectura. */}
      <form
        className="flex flex-col gap-6 bg-surface p-4 sm:p-6"
        noValidate
        {...(preview ? { inert: true } : {})}
        {...(interaction
          ? {
              method: "post",
              action: interaction.action,
              onSubmit: (event) => {
                event.preventDefault();
                interaction.onSubmit();
              },
            }
          : {})}
      >
        <div className="flex min-w-0 flex-col gap-2">
          <Heading className="text-xl font-semibold break-words">{title}</Heading>
          {intro ? <p className="break-words whitespace-pre-line text-fg-muted">{intro}</p> : null}
        </div>

        <fieldset
          className="flex min-w-0 flex-col gap-3"
          tabIndex={-1}
          aria-describedby={interaction?.errors.items ? id("items-error") : undefined}
          data-invalid-group={interaction?.errors.items ? "true" : undefined}
        >
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
                const itemError = interaction?.errors[`item:${item.id}`];
                const isPicked = interaction ? item.id in interaction.picked : false;
                return (
                  <li
                    key={item.id}
                    data-testid="form-item-option"
                    className="flex min-w-0 flex-col gap-2 rounded-md border border-border-strong p-3"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <input
                        id={id(`item-${item.id}`)}
                        type="checkbox"
                        disabled={locked}
                        className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
                        {...(interaction
                          ? {
                              checked: isPicked,
                              onChange: (event) =>
                                interaction.onToggleItem(item.id, event.target.checked),
                            }
                          : {})}
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
                      <div className="flex flex-wrap items-center gap-2 pl-8">
                        <label htmlFor={id(`qty-${item.id}`)} className="text-sm text-fg-muted">
                          Cantidad{requirement(item.quantityMode)}
                          <span className="sr-only">
                            {" "}
                            de {item.publicName || "servicio sin nombre"}
                          </span>
                        </label>
                        <Input
                          id={id(`qty-${item.id}`)}
                          inputMode="decimal"
                          disabled={locked}
                          className="w-24"
                          aria-invalid={itemError ? true : undefined}
                          aria-describedby={itemError ? id(`qty-${item.id}-error`) : undefined}
                          {...(interaction
                            ? {
                                value: interaction.picked[item.id] ?? "",
                                onChange: (event) =>
                                  interaction.onQuantityChange(item.id, event.target.value),
                              }
                            : {})}
                        />
                        {unit ? <span className="text-sm text-fg-muted">{unit}</span> : null}
                      </div>
                    ) : null}
                    <div className="pl-8">
                      <FieldError id={id(`qty-${item.id}-error`)} message={itemError} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <FieldError id={id("items-error")} message={interaction?.errors.items} />
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-4">
          <legend className={cn("mb-1 text-xs tracking-[0.08em] uppercase", BRAND_TEXT)}>
            Tus datos
          </legend>
          <TextField
            id={id("name")}
            fieldKey="name"
            label="Nombre"
            mode="required"
            autoComplete="name"
            disabled={locked}
            interaction={interaction}
          />
          <TextField
            id={id("email")}
            fieldKey="email"
            label="Correo"
            mode="required"
            type="email"
            autoComplete="email"
            disabled={locked}
            interaction={interaction}
          />
          {fields.phone !== "off" ? (
            <TextField
              id={id("phone")}
              fieldKey="phone"
              label="Teléfono"
              mode={fields.phone}
              type="tel"
              autoComplete="tel"
              disabled={locked}
              interaction={interaction}
            />
          ) : null}
          {fields.company !== "off" ? (
            <TextField
              id={id("company")}
              fieldKey="company"
              label="Empresa"
              mode={fields.company}
              autoComplete="organization"
              disabled={locked}
              interaction={interaction}
            />
          ) : null}
          {fields.comuna !== "off" ? (
            <TextField
              id={id("comuna")}
              fieldKey="comuna"
              label="Comuna"
              mode={fields.comuna}
              disabled={locked}
              interaction={interaction}
            />
          ) : null}
          {fields.serviceAddress !== "off" ? (
            <TextField
              id={id("address")}
              fieldKey="serviceAddress"
              label="Dirección del servicio"
              mode={fields.serviceAddress}
              disabled={locked}
              interaction={interaction}
            />
          ) : null}
          {fields.desiredDate !== "off" ? (
            <TextField
              id={id("date")}
              fieldKey="desiredDate"
              label="Fecha deseada"
              mode={fields.desiredDate}
              type="date"
              disabled={locked}
              interaction={interaction}
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
              <Textarea
                id={id("message")}
                disabled={locked}
                aria-invalid={interaction?.errors.message ? true : undefined}
                aria-describedby={interaction?.errors.message ? id("message-error") : undefined}
                {...(interaction
                  ? {
                      value: interaction.values.message,
                      onChange: (event) => interaction.onValueChange("message", event.target.value),
                    }
                  : {})}
              />
              <FieldError id={id("message-error")} message={interaction?.errors.message} />
            </div>
          ) : null}
        </fieldset>

        <div className="flex min-w-0 flex-col gap-3 rounded-md bg-surface-2 p-3 sm:p-4">
          <div className="flex min-w-0 items-start gap-3">
            <input
              id={id("consent")}
              type="checkbox"
              disabled={locked}
              className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
              aria-invalid={interaction?.errors.consent ? true : undefined}
              aria-describedby={interaction?.errors.consent ? id("consent-error") : undefined}
              {...(interaction
                ? {
                    checked: interaction.consent,
                    onChange: (event) => interaction.onConsentChange(event.target.checked),
                  }
                : {})}
            />
            <label htmlFor={id("consent")} className="min-w-0 text-sm break-words text-fg">
              {consentText ??
                "El aviso de privacidad aparecerá aquí cuando tu organización tenga un correo de contacto."}
            </label>
          </div>
          {safePolicyUrl ? (
            // Fuera de la etiqueta: un enlace dentro de un `label` se activa al marcar la casilla y confunde a
            // los lectores de pantalla.
            <p className="pl-8 text-sm">
              <a
                href={safePolicyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn("font-semibold underline", BRAND_TEXT)}
              >
                Leer la política de privacidad
              </a>
            </p>
          ) : null}
          <FieldError id={id("consent-error")} message={interaction?.errors.consent} />
        </div>

        {interaction?.beforeSubmit}

        {interaction ? (
          <noscript>
            <p className="rounded-md bg-danger-soft p-3 text-sm text-danger">
              Para enviar este formulario necesitas activar JavaScript.
            </p>
          </noscript>
        ) : null}

        <button
          type={interaction ? "submit" : "button"}
          disabled={locked || (interaction ? !interaction.ready || interaction.submitting : false)}
          data-testid="submit-request"
          className={cn(
            "inline-flex h-12 w-full items-center justify-center gap-2 rounded-sm px-5 text-base font-semibold shadow-1 disabled:opacity-100",
            interaction?.submitting && "opacity-80",
            BRAND_BG,
          )}
        >
          {interaction?.submitting ? <Loader2 aria-hidden className="size-5 animate-spin" /> : null}
          {interaction?.submitting ? "Enviando…" : "Enviar solicitud"}
        </button>
      </form>
    </div>
  );
}
