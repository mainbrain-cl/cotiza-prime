"use client";

import Link from "next/link";
import { useActionState } from "react";
import { MailCheck, TimerOff } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { INITIAL_CREATE_ACCOUNT_STATE, VERIFIED_NOT_FINISHED_HELP } from "@/lib/auth/account-setup";
import { signOutAction } from "@/lib/auth/actions";
import { FORGOT_PASSWORD_PATH, PRIVACY_PATH, SIGNUP_PATH, TERMS_PATH } from "@/lib/auth/paths";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/schemas";
import { completeAccountSetupAction } from "@/lib/auth/signup-actions";
import { PasswordFields } from "./password-fields";

export type CreateAccountFormProps = {
  /** El correo de la cuenta, a la vista: quien abre un enlace ajeno tiene que poder darse cuenta. */
  email: string;
  termsVersion: string;
  privacyVersion: string;
};

/**
 * Terminar de crear la cuenta (H-116, paso 2): nombre, contraseña dos veces y la casilla de términos y privacidad, con el
 * correo en un recuadro destacado y la salida «¿No es tu correo? Salir» (mitiga que alguien te haga entrar a una cuenta que es
 * suya). Las versiones de los documentos viajan ocultas: la base las compara con las vigentes.
 */
export function CreateAccountForm({ email, termsVersion, privacyVersion }: CreateAccountFormProps) {
  const [state, formAction] = useActionState(
    completeAccountSetupAction,
    INITIAL_CREATE_ACCOUNT_STATE,
  );

  if (state.expired) {
    return (
      <div className="flex flex-col gap-4" data-testid="create-account-expired">
        <div className="flex size-12 items-center justify-center rounded-md bg-warning-soft text-warning">
          <TimerOff aria-hidden strokeWidth={1.75} className="size-6" />
        </div>
        <FormAlert>{state.message}</FormAlert>
        <Link href={SIGNUP_PATH} className={buttonVariants({ size: "lg" })}>
          Pedir un enlace nuevo
        </Link>
        <p className="border-t border-border pt-4 text-sm text-fg-muted">
          {VERIFIED_NOT_FINISHED_HELP}
        </p>
        <Link
          href={FORGOT_PASSWORD_PATH}
          className="inline-flex min-h-11 w-fit items-center text-sm font-semibold text-accent underline-offset-4 hover:underline"
        >
          ¿Olvidaste tu contraseña?
        </Link>
      </div>
    );
  }

  const errors = state.fieldErrors ?? {};
  return (
    <div className="flex flex-col gap-5">
      <div
        className="flex flex-col gap-1.5 rounded-md bg-accent-soft px-4 py-3"
        data-testid="create-account-email-box"
      >
        <div className="flex items-start gap-3 text-sm text-fg">
          <MailCheck
            aria-hidden
            strokeWidth={1.75}
            className="mt-0.5 size-5 shrink-0 text-accent"
          />
          <p className="min-w-0">
            Estás creando la cuenta de{" "}
            <strong
              className="block text-sm font-semibold [overflow-wrap:anywhere] md:text-md"
              data-testid="create-account-email"
            >
              {email}
            </strong>
          </p>
        </div>
        <form action={signOutAction} className="pl-8">
          <button
            type="submit"
            data-testid="create-account-leave"
            className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline-offset-4 hover:underline"
          >
            ¿No es tu correo? Salir
          </button>
        </form>
      </div>

      <form action={formAction} className="flex flex-col gap-4" noValidate>
        <OfflineNotice />
        {state.message ? <FormAlert>{state.message}</FormAlert> : null}

        <Field label="Tu nombre" error={errors.fullName} required>
          {(control) => (
            <Input
              {...control}
              name="fullName"
              autoComplete="name"
              defaultValue={state.values?.fullName}
              maxLength={120}
              autoFocus
              required
            />
          )}
        </Field>

        <PasswordFields
          passwordError={errors.password}
          confirmError={errors.confirmPassword}
          hint={`Mínimo ${PASSWORD_MIN_LENGTH} caracteres.`}
        />

        <input type="hidden" name="termsVersion" value={termsVersion} />
        <input type="hidden" name="privacyVersion" value={privacyVersion} />

        <div className="flex flex-col gap-1.5">
          <label className="flex min-h-11 items-start gap-3 text-sm text-fg-muted">
            <input
              type="checkbox"
              name="acceptLegal"
              defaultChecked={state.values?.acceptLegal === "on"}
              required
              aria-invalid={Boolean(errors.acceptLegal)}
              className="mt-0.5 size-5 shrink-0 accent-accent"
            />
            <span>
              Acepto los{" "}
              <Link
                href={TERMS_PATH}
                target="_blank"
                className="font-semibold text-accent underline-offset-4 hover:underline"
              >
                términos y condiciones
              </Link>{" "}
              y la{" "}
              <Link
                href={PRIVACY_PATH}
                target="_blank"
                className="font-semibold text-accent underline-offset-4 hover:underline"
              >
                política de privacidad
              </Link>
              .
            </span>
          </label>
          {errors.acceptLegal ? (
            <p role="alert" className="text-sm text-danger">
              {errors.acceptLegal}
            </p>
          ) : null}
        </div>

        <SubmitButton pendingLabel="Creando tu cuenta…">Crear mi cuenta</SubmitButton>
      </form>
    </div>
  );
}
