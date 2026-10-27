"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form-controls";
import { saveDailyCapAction } from "@/lib/intake/builder-actions";
import {
  DAILY_CAP_DEFAULT,
  DAILY_CAP_MAX,
  DAILY_CAP_MIN,
  ORGANIZATION_DAILY_CAP,
  parseDailyCap,
} from "@/lib/intake/protection-model";

const SAVED_TOAST_ID = "intake-daily-cap-saved";
const OFFLINE_MESSAGE =
  "No pudimos comunicarnos con el servidor. Revisa tu conexión; lo que escribiste sigue aquí.";

/**
 * Tope diario de solicitudes del formulario (H-092). Solo Dueño y Administrador. Se valida aquí, en el
 * servidor y en la base. Guarda aparte del resto del formulario: no pide guardar nada más ni mueve su revisión.
 */
export function DailyCapControl({
  tenantId,
  formId,
  initialCap,
  editable,
}: {
  tenantId: string;
  formId: string;
  initialCap: number;
  editable: boolean;
}) {
  const [saved, setSaved] = useState(initialCap);
  const [text, setText] = useState(String(initialCap));
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const parsed = parseDailyCap(text);
  const dirty = !parsed.ok || parsed.value !== saved;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !editable) return;
    setBanner(null);
    const checked = parseDailyCap(text);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const result = await saveDailyCapAction(tenantId, formId, checked.value);
      if (result.status === "error") {
        setBanner(result.message);
        return;
      }
      const stored = result.dailyCap ?? checked.value;
      setSaved(stored);
      setText(String(stored));
      toast.success(result.message, { id: SAVED_TOAST_ID });
    } catch {
      setBanner(OFFLINE_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      id="tope-diario"
      data-testid="daily-cap-form"
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex min-w-0 scroll-mt-24 flex-col gap-3"
    >
      <p className="text-sm font-semibold text-fg">Tope de solicitudes por día</p>
      <p className="text-sm text-fg-muted">
        Es el máximo de solicitudes que este formulario recibe cada día (día de Chile). Al llegar,
        quien abra el formulario verá «este formulario no recibe más solicitudes hoy» y el Dueño y
        los Administradores reciben un aviso por correo, una sola vez al día. Al día siguiente
        vuelve a recibir. Además, toda tu organización tiene un tope de {ORGANIZATION_DAILY_CAP}{" "}
        solicitudes al día entre todos sus formularios, que no se puede subir desde aquí.
      </p>
      <Field
        label="Solicitudes por día"
        error={error ?? undefined}
        hint={`Entre ${DAILY_CAP_MIN} y ${DAILY_CAP_MAX}. Un formulario nuevo parte con ${DAILY_CAP_DEFAULT}.`}
      >
        {(control) => (
          <Input
            {...control}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={3}
            value={text}
            disabled={!editable}
            data-testid="daily-cap-input"
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
          />
        )}
      </Field>
      {banner ? (
        <p
          role="alert"
          data-testid="daily-cap-banner"
          className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm font-medium text-danger"
        >
          {banner}
        </p>
      ) : null}
      {editable ? (
        <div>
          <Button
            type="submit"
            variant="secondary"
            disabled={saving || !dirty}
            aria-disabled={saving || !dirty}
            data-testid="daily-cap-save"
          >
            {saving ? "Guardando…" : "Guardar tope"}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">
          El formulario está archivado: ya no se puede cambiar su tope.
        </p>
      )}
    </form>
  );
}
