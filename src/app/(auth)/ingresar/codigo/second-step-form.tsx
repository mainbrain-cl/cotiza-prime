"use client";

import { useActionState, useState } from "react";
import { CodeField } from "@/components/auth/code-field";
import { RecoveryCodeField } from "@/components/auth/recovery-code-field";
import { FormAlert, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";
import { verifyRecoveryCodeAction } from "@/lib/auth/recovery-code-actions";
import { verifySecondStepAction } from "@/lib/auth/second-step-actions";

const LINK_CLASS =
  "inline-flex min-h-11 items-center justify-center font-semibold text-accent underline-offset-4 hover:underline";

/**
 * La pantalla del código tras la contraseña: el código de 6 números de la aplicación y, si la persona no tiene su teléfono, el
 * código de respaldo (H-004b). Son dos formularios con acciones y errores propios; cambiar de uno a otro no da intentos nuevos
 * (el servidor los cuenta juntos).
 */
export function SecondStepForm() {
  const [mode, setMode] = useState<"app" | "backup">("app");
  const [appState, appAction] = useActionState(verifySecondStepAction, INITIAL_FORM_STATE);
  const [backupState, backupAction] = useActionState(verifyRecoveryCodeAction, INITIAL_FORM_STATE);
  // Al cambiar de formulario el foco va al campo nuevo (`autoFocus` se aplica al montarlo).

  if (mode === "backup") {
    return (
      <form action={backupAction} className="flex flex-col gap-4" noValidate>
        <OfflineNotice />
        {backupState.message ? <FormAlert>{backupState.message}</FormAlert> : null}
        <RecoveryCodeField
          error={backupState.fieldErrors?.recoveryCode}
          focusSignal={backupState.status === "error" ? backupState : undefined}
          autoFocus
        />
        <p className="rounded-sm bg-warning-soft px-3 py-2.5 text-sm font-medium text-warning">
          Al usarlo, la verificación en dos pasos se desactiva y tendrás que activarla de nuevo con
          tu teléfono.
        </p>
        <SubmitButton pendingLabel="Verificando…">Entrar con el código de respaldo</SubmitButton>
        <button type="button" className={LINK_CLASS} onClick={() => setMode("app")}>
          Volver al código de mi aplicación
        </button>
      </form>
    );
  }

  return (
    <form action={appAction} className="flex flex-col gap-4" noValidate>
      <OfflineNotice />
      {appState.message ? <FormAlert>{appState.message}</FormAlert> : null}
      <CodeField
        error={appState.fieldErrors?.code}
        focusSignal={appState.status === "error" ? appState : undefined}
        autoFocus
      />
      <SubmitButton pendingLabel="Verificando…">Verificar</SubmitButton>
      <button type="button" className={LINK_CLASS} onClick={() => setMode("backup")}>
        ¿No tienes tu teléfono? Usa un código de respaldo
      </button>
    </form>
  );
}
