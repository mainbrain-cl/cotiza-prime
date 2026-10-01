"use client";

import Link from "next/link";
import { useActionState } from "react";
import { MailCheck } from "lucide-react";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { signUpAction } from "@/lib/auth/actions";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";
import { LOGIN_PATH, PRIVACY_PATH, TERMS_PATH } from "@/lib/auth/paths";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/schemas";

export function SignUpForm() {
  const [state, formAction] = useActionState(signUpAction, INITIAL_FORM_STATE);

  if (state.status === "sent") {
    return (
      <div className="flex flex-col gap-4" data-testid="signup-sent">
        <div className="flex size-12 items-center justify-center rounded-md bg-success-soft text-success">
          <MailCheck aria-hidden strokeWidth={1.75} className="size-6" />
        </div>
        <h2 className="text-lg">Revisa tu correo</h2>
        <p className="text-fg-muted">
          Te enviamos un enlace a <strong className="text-fg">{state.values?.email}</strong> para
          verificar tu dirección. El enlace caduca, así que ábrelo pronto. Hasta que verifiques tu
          correo no podrás crear una organización.
        </p>
        <p className="text-sm text-fg-muted">
          Si ya tenías una cuenta con este correo,{" "}
          <Link
            href={LOGIN_PATH}
            className="font-semibold text-accent underline-offset-4 hover:underline"
          >
            ingresa con tu contraseña
          </Link>
          .
        </p>
      </div>
    );
  }

  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.message ? <FormAlert>{state.message}</FormAlert> : null}

      <Field label="Tu nombre" error={errors.fullName} required>
        {(control) => (
          <Input
            {...control}
            name="fullName"
            autoComplete="name"
            defaultValue={state.values?.fullName}
            required
            maxLength={120}
          />
        )}
      </Field>

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

      <Field
        label="Contraseña"
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

      <div className="flex flex-col gap-1.5">
        <label className="flex min-h-11 items-start gap-3 text-sm text-fg-muted">
          <input
            type="checkbox"
            name="acceptLegal"
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
  );
}
