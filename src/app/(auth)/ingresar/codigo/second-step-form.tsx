"use client";

import { useActionState } from "react";
import { CodeField } from "@/components/auth/code-field";
import { FormAlert, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";
import { verifySecondStepAction } from "@/lib/auth/second-step-actions";

export function SecondStepForm() {
  const [state, formAction] = useActionState(verifySecondStepAction, INITIAL_FORM_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <OfflineNotice />
      {state.message ? <FormAlert>{state.message}</FormAlert> : null}
      <CodeField
        error={state.fieldErrors?.code}
        focusSignal={state.status === "error" ? state : undefined}
        autoFocus
      />
      <SubmitButton pendingLabel="Verificando…">Verificar</SubmitButton>
    </form>
  );
}
