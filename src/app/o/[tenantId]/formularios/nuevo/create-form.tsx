"use client";

import { useActionState, useState } from "react";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/auth/form-state";
import { createIntakeFormAction } from "@/lib/intake/builder-actions";
import { FORM_NAME_MAX } from "@/lib/intake/builder-model";

/** Crear un formulario: solo pide el nombre interno; lo demás se arma en el editor. */
export function CreateIntakeForm({ tenantId }: { tenantId: string }) {
  // El identificador se crea una vez al abrir la pantalla: un doble clic no crea dos formularios.
  const [formId] = useState(() => crypto.randomUUID());
  const [state, formAction] = useActionState(
    (previous: FormState, formData: FormData) =>
      createIntakeFormAction(tenantId, previous, formData),
    INITIAL_FORM_STATE,
  );
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <OfflineNotice />
      {state.status === "error" && state.message ? <FormAlert>{state.message}</FormAlert> : null}
      <input type="hidden" name="formId" value={formId} />
      <Field
        label="Nombre interno"
        required
        error={errors.name}
        hint="Solo lo ves tú y tu equipo. Por ejemplo: Fletes en la web."
      >
        {(control) => (
          <Input
            {...control}
            name="name"
            maxLength={FORM_NAME_MAX}
            defaultValue={state.values?.name ?? ""}
            autoComplete="off"
          />
        )}
      </Field>
      <SubmitButton pendingLabel="Creando…">Crear formulario</SubmitButton>
    </form>
  );
}
