"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormAlert, Input } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { saveDiscountCapAction } from "@/lib/catalog/discount-cap-actions";
import {
  describeMaxDiscount,
  maxDiscountToText,
  parseMaxDiscountText,
} from "@/lib/quotes/discount-cap";

const SAVED_TOAST_ID = "catalog-discount-cap-saved";
const OFFLINE_MESSAGE =
  "No pudimos comunicarnos con el servidor. Revisa tu conexión; lo que escribiste sigue aquí.";

/**
 * Descuento máximo de los Comerciales (H-041). Lo cambia quien maneja el catálogo (Dueño y Administrador); el resto solo lo lee.
 * Se valida aquí, en la acción y en la base. Vacío = «Sin tope». El Dueño y los Administradores no tienen este límite.
 */
export function DiscountCapForm({
  tenantId,
  initialBp,
  editable,
}: {
  tenantId: string;
  initialBp: number | null;
  editable: boolean;
}) {
  const [savedBp, setSavedBp] = useState(initialBp);
  const [text, setText] = useState(maxDiscountToText(initialBp));
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleId = useId();

  const parsed = parseMaxDiscountText(text);
  const dirty = !parsed.ok || parsed.value !== savedBp;
  const preview = parsed.ok ? describeMaxDiscount(parsed.value) : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !editable) return;
    setBanner(null);
    const checked = parseMaxDiscountText(text);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError(null);
    setSaving(true);
    const submittedText = text;
    try {
      const result = await saveDiscountCapAction(tenantId, checked.value);
      if (result.status === "error") {
        setBanner(result.message);
        return;
      }
      setSavedBp(result.maxDiscountBp);
      // Si mientras guardaba se escribió otro valor, ese es el que vale: no se le devuelve el anterior.
      setText((current) =>
        current === submittedText ? maxDiscountToText(result.maxDiscountBp) : current,
      );
      toast.success(result.message, { id: SAVED_TOAST_ID });
    } catch {
      setBanner(OFFLINE_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-labelledby={titleId}
      data-testid="discount-cap-card"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
    >
      <h2 id={titleId} className="text-lg">
        Descuento máximo de los Comerciales
      </h2>
      <p className="text-sm text-fg-muted">
        Es lo más que un Comercial puede descontar en cada línea de una cotización y en el descuento
        general. El Dueño y los Administradores no tienen este límite. Para fijar el precio de un
        servicio usa «Bloquear el precio» en el servicio.
      </p>
      <form
        data-testid="discount-cap-form"
        onSubmit={(event) => void submit(event)}
        noValidate
        className="flex flex-col gap-3"
      >
        <OfflineNotice />
        {banner ? (
          <div data-testid="discount-cap-banner">
            <FormAlert>{banner}</FormAlert>
          </div>
        ) : null}
        <Field
          label="Descuento máximo (%)"
          error={error ?? undefined}
          hint="Déjalo vacío para no poner tope. Con 0, ningún Comercial puede dar descuentos. Por ejemplo, 10 o 12,5."
        >
          {(control) => (
            <div className="relative sm:max-w-48">
              <Input
                {...control}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="Sin tope"
                value={text}
                disabled={!editable}
                data-testid="discount-cap-input"
                className="pr-8 tabular-nums"
                onChange={(event) => {
                  setText(event.target.value);
                  setError(null);
                }}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-fg-muted"
              >
                %
              </span>
            </div>
          )}
        </Field>
        <p
          aria-live="polite"
          data-testid="discount-cap-preview"
          className="min-h-6 rounded-sm bg-surface-2 px-3 py-2 text-sm text-fg"
        >
          {preview ?? "Escribe un porcentaje para ver cómo quedará."}
        </p>
        {editable ? (
          <div>
            <Button
              type="submit"
              variant="secondary"
              disabled={saving || !dirty}
              aria-disabled={saving || !dirty}
              data-testid="discount-cap-save"
            >
              {saving ? "Guardando…" : "Guardar descuento máximo"}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-fg-muted" data-testid="discount-cap-readonly">
            Solo el Dueño y los Administradores pueden cambiarlo.
          </p>
        )}
      </form>
    </section>
  );
}
