"use client";

import { useActionState } from "react";
import { MailCheck } from "lucide-react";
import { FormAlert, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { INITIAL_CONFIRM_EMAIL_STATE } from "@/lib/auth/account-setup";
import { confirmEmailLinkAction } from "@/lib/auth/signup-actions";
import { ExpiredLink } from "./expired-link";

/**
 * «Continuar»: el clic canjea el enlace del correo (un POST). El código viaja en un campo oculto; abrir la página no lo gasta.
 * Si el enlace ya no sirve, la misma pantalla lo dice y ofrece pedir otro; si falló otra cosa (sin red, Supabase no
 * respondió), se puede volver a intentar sin perder el enlace.
 */
export function ConfirmEmailForm({ tokenHash }: { tokenHash: string }) {
  const [state, formAction] = useActionState(confirmEmailLinkAction, INITIAL_CONFIRM_EMAIL_STATE);

  if (state.expired) return <ExpiredLink heading />;

  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="confirm-email-form">
      <OfflineNotice />
      {state.message ? <FormAlert>{state.message}</FormAlert> : null}
      <div className="flex items-start gap-3 rounded-md bg-accent-soft px-4 py-3 text-sm text-fg">
        <MailCheck aria-hidden strokeWidth={1.75} className="mt-0.5 size-5 shrink-0 text-accent" />
        <p>Al continuar confirmamos que este correo es tuyo. El enlace sirve una sola vez.</p>
      </div>
      <input type="hidden" name="token_hash" value={tokenHash} />
      <SubmitButton pendingLabel="Confirmando…">Continuar</SubmitButton>
    </form>
  );
}
