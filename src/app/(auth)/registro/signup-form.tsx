"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { MailCheck } from "lucide-react";
import { AntibotWidget } from "@/components/intake/antibot-widget";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { SIGNUP_ANTIBOT_ACTION, SIGNUP_SENT_SUFFIX } from "@/lib/auth/account-setup";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/auth/form-state";
import { FORGOT_PASSWORD_PATH, LOGIN_PATH, PRIVACY_PATH } from "@/lib/auth/paths";
import { signUpAction } from "@/lib/auth/signup-actions";

const LINK_CLASS =
  "inline-flex min-h-11 items-center font-semibold text-accent underline-offset-4 hover:underline";

export type SignUpFormProps = {
  antibot: { provider: "turnstile" | "memory"; siteKey: string | null };
};

/**
 * Paso 1 del registro (H-116): solo el correo. La pantalla responde igual exista o no la cuenta. La prueba anti-robot se
 * vuelve a montar tras cada envío (cada prueba sirve una sola vez).
 */
export function SignUpForm({ antibot }: SignUpFormProps) {
  const [state, formAction] = useActionState(signUpAction, INITIAL_FORM_STATE);
  const [antibotToken, setAntibotToken] = useState<string | null>(null);
  const [antibotEpoch, setAntibotEpoch] = useState(0);
  // El resultado que la persona ya cerró para pedir otro enlace: un resultado nuevo es otro objeto y vuelve a mostrarse.
  const [dismissed, setDismissed] = useState<FormState | null>(null);

  function submit(formData: FormData) {
    setAntibotToken(null);
    setAntibotEpoch((epoch) => epoch + 1);
    formAction(formData);
  }

  if (state.status === "sent" && state !== dismissed) {
    return (
      <div className="flex flex-col gap-4" data-testid="signup-sent">
        <div className="flex size-12 items-center justify-center rounded-md bg-success-soft text-success">
          <MailCheck aria-hidden strokeWidth={1.75} className="size-6" />
        </div>
        <h2 className="text-lg">Revisa tu correo</h2>
        <p className="text-fg-muted">
          Te enviamos un enlace a{" "}
          <strong className="[overflow-wrap:anywhere] text-fg" data-testid="signup-sent-email">
            {state.values?.email}
          </strong>
          . {SIGNUP_SENT_SUFFIX}
        </p>
        <div className="flex flex-col gap-1 border-t border-border pt-4 text-sm text-fg-muted sm:flex-row sm:flex-wrap sm:gap-x-5">
          <Link href={LOGIN_PATH} className={LINK_CLASS}>
            Ingresar
          </Link>
          <Link href={FORGOT_PASSWORD_PATH} className={LINK_CLASS}>
            ¿Olvidaste tu contraseña?
          </Link>
          <button
            type="button"
            className={`${LINK_CLASS} text-left`}
            data-testid="signup-resend"
            onClick={() => setDismissed(state)}
          >
            ¿No te llegó? Pedir otro enlace
          </button>
        </div>
      </div>
    );
  }

  const errors = state.fieldErrors ?? {};
  return (
    <form action={submit} className="flex flex-col gap-4" noValidate>
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
            autoFocus
            required
          />
        )}
      </Field>

      <input type="hidden" name="antibotToken" value={antibotToken ?? ""} />
      <AntibotWidget
        key={antibotEpoch}
        provider={antibot.provider}
        siteKey={antibot.siteKey}
        action={SIGNUP_ANTIBOT_ACTION}
        onToken={setAntibotToken}
      />
      {errors.antibotToken ? (
        <p role="alert" className="text-sm text-danger">
          {errors.antibotToken}
        </p>
      ) : null}

      <p className="text-sm text-fg-muted">
        Usaremos tu correo solo para enviarte el enlace. Lee la{" "}
        <Link
          href={PRIVACY_PATH}
          target="_blank"
          className="font-semibold text-accent underline-offset-4 hover:underline"
        >
          política de privacidad
        </Link>
        .
      </p>

      <SubmitButton pendingLabel="Enviando…">Enviarme el enlace</SubmitButton>
    </form>
  );
}
