"use client";

import Link from "next/link";
import { useActionState } from "react";
import { MailCheck } from "lucide-react";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { requestPasswordResetAction } from "@/lib/auth/actions";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";
import { LOGIN_PATH } from "@/lib/auth/paths";
import { RESET_REQUEST_SENT_MESSAGE } from "@/lib/auth/messages";

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(requestPasswordResetAction, INITIAL_FORM_STATE);

  if (state.status === "sent") {
    return (
      <div className="flex flex-col gap-4" data-testid="reset-request-sent">
        <div className="flex size-12 items-center justify-center rounded-md bg-success-soft text-success">
          <MailCheck aria-hidden strokeWidth={1.75} className="size-6" />
        </div>
        <h2 className="text-lg">Revisa tu correo</h2>
        <p className="text-fg-muted">{RESET_REQUEST_SENT_MESSAGE}</p>
        <Link
          href={LOGIN_PATH}
          className="text-sm font-semibold text-accent underline-offset-4 hover:underline"
        >
          Volver a ingresar
        </Link>
      </div>
    );
  }

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

      <SubmitButton pendingLabel="Enviando…">Enviar enlace</SubmitButton>
    </form>
  );
}
