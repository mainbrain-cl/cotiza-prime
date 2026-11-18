"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { signInAction } from "@/lib/auth/actions";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";
import { FORGOT_PASSWORD_PATH } from "@/lib/auth/paths";

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
        <Link
          href={FORGOT_PASSWORD_PATH}
          className="inline-flex min-h-11 items-center font-semibold text-accent underline-offset-4 hover:underline"
        >
          ¿Olvidaste tu contraseña?
        </Link>
      </p>
    </form>
  );
}
