"use client";

import { useActionState } from "react";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { signInAction } from "@/lib/auth/actions";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";

export function LoginForm() {
  const [state, formAction] = useActionState(signInAction, INITIAL_FORM_STATE);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <OfflineNotice />
      {state.message ? <FormAlert>{state.message}</FormAlert> : null}

      <Field label="Correo" error={errors.email} required>
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            defaultValue={state.values?.email}
            required
          />
        )}
      </Field>

      <Field label="Contraseña" error={errors.password} required>
        {(control) => (
          <Input
            {...control}
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        )}
      </Field>

      <SubmitButton pendingLabel="Ingresando…">Ingresar</SubmitButton>

      <p className="text-center text-sm text-fg-subtle">
        ¿Olvidaste tu contraseña? Recuperarla estará disponible pronto.
      </p>
    </form>
  );
}
