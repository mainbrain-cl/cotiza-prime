"use client";

import { useActionState, useState } from "react";
import { FormAlert, SubmitButton } from "@/components/ui/form-controls";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { acceptInvitationAction, leaveInvitationAction } from "@/lib/team/accept-actions";
import {
  INITIAL_ACCEPT_STATE,
  INVITATION_OFFLINE_MESSAGE,
  INVITATION_VIEW_FIELD,
  type AcceptState,
} from "@/lib/team/accept-model";
import { Button } from "@/components/ui/button";

/**
 * El botón «Unirme» de la invitación (H-009). Unirse exige un clic: abrir el enlace nunca acepta nada. El código
 * viaja en una cookie, no en este formulario, y el rol lo decide la invitación. El formulario solo lleva la huella
 * de la invitación que se mostró (`viewFingerprint`, nunca el código): así el clic acepta ESA invitación y no otra
 * que una página ajena haya dejado en la cookie entre medio. Si el código ya no sirve, ofrece salir.
 */
export function AcceptInvitationForm({
  viewFingerprint,
  label = "Unirme",
  pendingLabel = "Uniéndote…",
  offerLeave = true,
}: {
  /** Huella de la invitación que muestra la pantalla (`invitationViewFingerprint`). */
  viewFingerprint: string;
  label?: string;
  pendingLabel?: string;
  /** Falso cuando la persona ya es parte de la organización: «Seguir sin unirme» no tendría sentido. */
  offerLeave?: boolean;
}) {
  // Si la petición no llega al servidor (sin red), se queda en esta pantalla con un mensaje claro: dejarla
  // subir a la pantalla de error diría «problema de nuestro lado» cuando el problema es la conexión.
  const [state, formAction] = useActionState<AcceptState, FormData>(async (_previous, formData) => {
    try {
      return await acceptInvitationAction(formData);
    } catch {
      return { status: "error", message: INVITATION_OFFLINE_MESSAGE };
    }
  }, INITIAL_ACCEPT_STATE);

  return (
    <div className="flex flex-col gap-3">
      <form
        action={formAction}
        noValidate
        data-testid="accept-invitation-form"
        className="flex flex-col gap-3"
      >
        <input type="hidden" name={INVITATION_VIEW_FIELD} value={viewFingerprint} />
        <OfflineNotice />
        {state.status === "error" && state.message ? <FormAlert>{state.message}</FormAlert> : null}
        {state.dead ? null : <SubmitButton pendingLabel={pendingLabel}>{label}</SubmitButton>}
      </form>
      {/* Una sola salida: si el código ya no sirve se llama «Entendido»; si no, «Seguir sin unirme». */}
      {offerLeave || state.dead ? (
        <LeaveInvitationButton
          label={state.dead ? "Entendido" : "Seguir sin unirme"}
          variant={state.dead ? "secondary" : "ghost"}
        />
      ) : null}
    </div>
  );
}

/** «Seguir sin unirme»: borra el código guardado y vuelve al inicio. */
export function LeaveInvitationButton({
  label = "Seguir sin unirme",
  variant = "ghost",
}: {
  label?: string;
  variant?: "ghost" | "secondary";
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={async () => {
        setError(null);
        try {
          await leaveInvitationAction();
        } catch {
          setError(INVITATION_OFFLINE_MESSAGE);
        }
      }}
      className="flex flex-col gap-3"
    >
      {error ? <FormAlert>{error}</FormAlert> : null}
      <Button type="submit" size="lg" variant={variant} className="w-full">
        {label}
      </Button>
    </form>
  );
}
