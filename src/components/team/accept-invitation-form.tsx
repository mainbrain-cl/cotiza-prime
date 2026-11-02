"use client";

import { useActionState } from "react";
import { FormAlert, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import {
  INITIAL_ACCEPT_STATE,
  acceptInvitationAction,
  leaveInvitationAction,
  type AcceptState,
} from "@/lib/team/accept-actions";
import { Button } from "@/components/ui/button";

/**
 * El botón «Unirme» de la invitación (H-009). Unirse exige un clic: abrir el enlace nunca acepta nada. El código
 * viaja en una cookie, no en este formulario, y el rol lo decide la invitación: aquí no se manda ni se muestra
 * nada que se pueda cambiar. Si el código ya no sirve, ofrece salir en vez de reintentar.
 */
export function AcceptInvitationForm({
  label = "Unirme",
  pendingLabel = "Uniéndote…",
}: {
  label?: string;
  pendingLabel?: string;
}) {
  const [state, formAction] = useActionState<AcceptState, FormData>(
    acceptInvitationAction,
    INITIAL_ACCEPT_STATE,
  );

  return (
    <div className="flex flex-col gap-3">
      <form
        action={formAction}
        noValidate
        data-testid="accept-invitation-form"
        className="flex flex-col gap-3"
      >
        <OfflineNotice />
        {state.status === "error" && state.message ? <FormAlert>{state.message}</FormAlert> : null}
        {state.dead ? null : <SubmitButton pendingLabel={pendingLabel}>{label}</SubmitButton>}
      </form>
      {state.dead ? (
        <form action={leaveInvitationAction}>
          <Button type="submit" size="lg" variant="secondary" className="w-full">
            Entendido
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/** «Seguir sin unirme»: borra el código guardado y vuelve al inicio. */
export function LeaveInvitationButton({ label = "Seguir sin unirme" }: { label?: string }) {
  return (
    <form action={leaveInvitationAction}>
      <Button type="submit" size="lg" variant="ghost" className="w-full">
        {label}
      </Button>
    </form>
  );
}
