"use client";

import { useActionState } from "react";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { resetPasswordAction } from "@/lib/auth/actions";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/schemas";

export function ResetPasswordForm() {
  const [state, formAction] = useActionState(resetPasswordAction, INITIAL_FORM_STATE);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <OfflineNotice />
      {state.message ? <FormAlert>{state.message}</FormAlert> : null}

      <Field
        label="Contraseña nueva"
        error={errors.password}
        hint={`Mínimo ${PASSWORD_MIN_LENGTH} caracteres.`}
        required
      >
        {(control) => (
          <Input
            {...control}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            required
          />
        )}
      </Field>

      <Field label="Repite la contraseña" error={errors.confirmPassword} required>
        {(control) => (
          <Input
            {...control}
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
          />
        )}
      </Field>

      <SubmitButton pendingLabel="Guardando…">Cambiar contraseña</SubmitButton>
    </form>
  );
}
