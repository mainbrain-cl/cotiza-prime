"use client";

import { Loader2, RotateCw, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/intake/confirm-action";
import { Button } from "@/components/ui/button";
import { TONE_CLASSES, type StatusTone } from "@/components/ui/status-badge";
import { resendInvitationAction, revokeInvitationAction } from "@/lib/team/actions";
import { INVITATION_TTL_DAYS, type InvitationTone } from "@/lib/team/invitations-model";
import { cn } from "@/lib/utils";

/** Una invitación lista para mostrar: todo el texto ya viene armado desde el servidor. */
export type InvitationItem = {
  id: string;
  email: string | null;
  roleLabel: string;
  statusLabel: string;
  tone: InvitationTone;
  needsAttention: boolean;
  /** La invitación ya venció (se decide con la fecha, no con el texto de la insignia). */
  expired: boolean;
  createdLabel: string;
  expiresLabel: string;
  sentLabel: string;
  invitedBy: string | null;
  resendsLeft: number;
};

const TONES: Record<InvitationTone, StatusTone> = {
  neutral: "neutral",
  accent: "accent",
  warning: "warning",
  danger: "danger",
  success: "success",
};

const RESULT_TOAST_ID = "invitation-result";

/** Lista de invitaciones pendientes, con reenviar y cancelar. Cada acción la vuelve a verificar el servidor. */
export function InvitationList({ tenantId, items }: { tenantId: string; items: InvitationItem[] }) {
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  function resend(id: string) {
    setBusyId(id);
    startTransition(async () => {
      try {
        const result = await resendInvitationAction(tenantId, id);
        if (result.status === "ok") toast.success(result.message, { id: RESULT_TOAST_ID });
        else toast.error(result.message, { id: RESULT_TOAST_ID });
      } catch {
        toast.error("No pudimos reenviar la invitación. Revisa tu conexión e inténtalo de nuevo.", {
          id: RESULT_TOAST_ID,
        });
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <ul aria-label="Invitaciones pendientes" className="grid gap-3" data-testid="invitation-list">
      {items.map((item) => {
        const classes = TONE_CLASSES[TONES[item.tone]];
        const busy = pending && busyId === item.id;
        return (
          <li
            key={item.id}
            data-testid="invitation-row"
            data-status-label={item.statusLabel}
            className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-1"
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <p data-testid="invitation-email" className="min-w-0 font-semibold break-all text-fg">
                {item.email ?? "Correo no disponible"}
              </p>
              <span
                data-testid="invitation-status"
                className={cn(
                  "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap",
                  classes.badge,
                )}
              >
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", classes.dot)} />
                {item.statusLabel}
              </span>
            </div>

            <dl className="grid gap-x-6 gap-y-1 text-sm text-fg-muted sm:grid-cols-2">
              <div className="flex gap-1.5">
                <dt className="sr-only">Rol</dt>
                <dd data-testid="invitation-role" className="font-semibold text-fg">
                  {item.roleLabel}
                </dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="sr-only">Vigencia</dt>
                <dd data-testid="invitation-expiry">{item.expiresLabel}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="sr-only">Invitada</dt>
                <dd data-testid="invitation-created">{item.createdLabel}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="sr-only">Último envío</dt>
                <dd>{item.sentLabel}</dd>
              </div>
              {item.invitedBy ? (
                <div className="flex gap-1.5">
                  <dt className="sr-only">Invitó</dt>
                  <dd>Invitó {item.invitedBy}</dd>
                </div>
              ) : null}
            </dl>

            {item.needsAttention ? (
              <p className="text-sm text-fg-muted">
                {item.expired
                  ? `El enlace venció. Reenvíala para darle otros ${INVITATION_TTL_DAYS} días.`
                  : "El correo no llegó a salir o rebotó. Revisa que la dirección esté bien y reenvíala."}
              </p>
            ) : null}

            {item.resendsLeft === 0 ? (
              <p data-testid="invitation-no-resends" className="text-sm text-fg-muted">
                Ya usaste los reenvíos de esta invitación. Si la persona la necesita de nuevo,
                cancélala e invítala otra vez.
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="invitation-resend"
                disabled={pending || item.resendsLeft === 0}
                onClick={() => resend(item.id)}
              >
                {busy ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCw aria-hidden />}
                Reenviar
              </Button>
              <ConfirmAction
                testId={`invitation-revoke-${item.id}`}
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="invitation-revoke"
                    disabled={pending}
                  >
                    <Trash2 aria-hidden />
                    Cancelar invitación
                  </Button>
                }
                title="¿Cancelar esta invitación?"
                description={`El enlace que se envió a ${item.email ?? "esta persona"} dejará de servir de inmediato. Si cambias de opinión, puedes invitarla de nuevo.`}
                confirmLabel="Sí, cancelar"
                pendingLabel="Cancelando…"
                onConfirm={async () => {
                  const result = await revokeInvitationAction(tenantId, item.id);
                  if (result.status === "ok") {
                    toast.success(result.message, { id: RESULT_TOAST_ID });
                    return null;
                  }
                  return result.message;
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
