"use client";

import { FilePlus2, Loader2, RotateCcw, ShieldAlert, Trash2, UserCheck } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/intake/confirm-action";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FormAlert, Select, Textarea } from "@/components/ui/form-controls";
import {
  anonymizeRequestAction,
  assignRequestAction,
  discardRequestAction,
  restoreRequestAction,
  type RequestActionResult,
} from "@/lib/intake/requests-actions";
import {
  ANONYMIZE_REASONS,
  DISCARD_NOTE_MAX,
  DISCARD_REASONS,
  type RequestPermissions,
} from "@/lib/intake/requests-model";
import { tenantPath } from "@/lib/tenant/constants";

export type AssigneeOption = { userId: string; label: string };

const SUCCESS_TOAST_ID = "request-success";

/** Muestra el resultado: aviso si salió bien, mensaje (para quien llama) si salió mal. */
function outcome(result: RequestActionResult): string | null {
  if (result.status === "ok") {
    toast.success(result.message, { id: SUCCESS_TOAST_ID });
    return null;
  }
  return result.message;
}

/**
 * Acciones de una solicitud (H-089). Los botones que aparecen dependen del rol, pero el permiso real lo
 * verifica la base de datos en cada acción: si alguien llega sin permiso, ve un mensaje claro.
 */
export function RequestActions({
  tenantId,
  requestId,
  permissions,
  assignees,
  currentAssigneeId,
}: {
  tenantId: string;
  requestId: string;
  permissions: RequestPermissions;
  assignees: AssigneeOption[] | null;
  currentAssigneeId: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [assignee, setAssignee] = useState(currentAssigneeId ?? "");
  const [assignError, setAssignError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [discardReason, setDiscardReason] = useState("");
  const [discardNote, setDiscardNote] = useState("");
  const [anonymizeReason, setAnonymizeReason] = useState("");

  function assign() {
    setAssignError(null);
    startTransition(async () => {
      const result = await assignRequestAction(tenantId, requestId, assignee);
      setAssignError(outcome(result));
    });
  }

  function restore() {
    setRestoreError(null);
    startTransition(async () => {
      const result = await restoreRequestAction(tenantId, requestId);
      setRestoreError(outcome(result));
    });
  }

  const nothing =
    !permissions.canAssign &&
    !permissions.canDiscard &&
    !permissions.canRestore &&
    !permissions.canAnonymize &&
    !permissions.canConvert;
  if (nothing) return null;

  return (
    <section
      aria-labelledby="request-actions-title"
      data-testid="request-actions"
      className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
    >
      <h2 id="request-actions-title" className="text-lg">
        Qué hacer con esta solicitud
      </h2>

      {permissions.canAssign ? (
        <div className="flex flex-col gap-3">
          {assignees === null ? (
            <FormAlert>No pudimos cargar al equipo. Recarga la página en unos minutos.</FormAlert>
          ) : (
            <>
              <Field
                label="Asignar a"
                hint="Solo aparecen personas activas del equipo que pueden cotizar."
              >
                {(control) => (
                  <Select
                    {...control}
                    data-testid="assignee-select"
                    value={assignee}
                    onChange={(event) => setAssignee(event.target.value)}
                    disabled={pending}
                  >
                    <option value="">Elige a una persona</option>
                    {assignees.map((option) => (
                      <option key={option.userId} value={option.userId}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {assignError ? <FormAlert>{assignError}</FormAlert> : null}
              <div>
                <Button
                  type="button"
                  data-testid="assign-submit"
                  onClick={assign}
                  disabled={pending || assignee === "" || assignee === currentAssigneeId}
                >
                  {pending ? (
                    <Loader2 aria-hidden className="animate-spin" />
                  ) : (
                    <UserCheck aria-hidden />
                  )}
                  {currentAssigneeId ? "Reasignar" : "Asignar"}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap items-start gap-3">
        {permissions.canConvert ? (
          <div className="flex flex-col gap-1">
            <Link
              href={tenantPath(tenantId, `solicitudes/${requestId}/convertir`)}
              data-testid="convert-open"
              className={buttonVariants({ variant: "primary" })}
            >
              <FilePlus2 aria-hidden />
              Crear cotización
            </Link>
          </div>
        ) : null}

        {permissions.canRestore ? (
          <div className="flex flex-col gap-1">
            <Button
              type="button"
              variant="secondary"
              data-testid="restore-submit"
              onClick={restore}
              disabled={pending}
            >
              {pending ? (
                <Loader2 aria-hidden className="animate-spin" />
              ) : (
                <RotateCcw aria-hidden />
              )}
              Restaurar
            </Button>
            {restoreError ? <FormAlert>{restoreError}</FormAlert> : null}
          </div>
        ) : null}

        {permissions.canDiscard ? (
          <ConfirmAction
            testId="discard"
            trigger={
              <Button type="button" variant="secondary" disabled={pending}>
                <Trash2 aria-hidden />
                Descartar
              </Button>
            }
            title="¿Descartar esta solicitud?"
            description="Sale de la lista de pendientes y queda en «Descartadas». Se borra sola a los 30 días. Si te equivocas, puedes restaurarla antes de que pase ese plazo."
            confirmLabel="Sí, descartar"
            pendingLabel="Descartando…"
            onConfirm={async () => {
              if (discardReason === "") return "Elige el motivo para descartarla.";
              return outcome(
                await discardRequestAction(tenantId, requestId, discardReason, discardNote),
              );
            }}
          >
            <div className="flex flex-col gap-3">
              <Field label="Motivo" required>
                {(control) => (
                  <Select
                    {...control}
                    data-testid="discard-reason"
                    value={discardReason}
                    onChange={(event) => setDiscardReason(event.target.value)}
                  >
                    <option value="">Elige un motivo</option>
                    {DISCARD_REASONS.map((reason) => (
                      <option key={reason.value} value={reason.value}>
                        {reason.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Nota breve (opcional)" hint={`Hasta ${DISCARD_NOTE_MAX} caracteres.`}>
                {(control) => (
                  <Textarea
                    {...control}
                    data-testid="discard-note"
                    rows={2}
                    maxLength={DISCARD_NOTE_MAX}
                    value={discardNote}
                    onChange={(event) => setDiscardNote(event.target.value)}
                  />
                )}
              </Field>
            </div>
          </ConfirmAction>
        ) : null}

        {permissions.canAnonymize ? (
          <ConfirmAction
            testId="anonymize"
            trigger={
              <Button type="button" variant="ghost" disabled={pending}>
                <ShieldAlert aria-hidden />
                Anonimizar datos
              </Button>
            }
            title="¿Eliminar los datos de esta persona?"
            description="Se borran para siempre su nombre, correo, teléfono, empresa, dirección y mensaje. No se puede deshacer. Úsalo cuando la persona pida que borremos sus datos (derecho de supresión de la Ley 21.719). Quedan los servicios que pidió, las fechas y quién estaba a cargo, y la solicitud ya no se podrá asignar ni convertir en cotización."
            confirmLabel="Sí, eliminar los datos"
            pendingLabel="Eliminando…"
            onConfirm={async () => {
              if (anonymizeReason === "") return "Elige el motivo para eliminar los datos.";
              return outcome(await anonymizeRequestAction(tenantId, requestId, anonymizeReason));
            }}
          >
            <Field label="Motivo" required>
              {(control) => (
                <Select
                  {...control}
                  data-testid="anonymize-reason"
                  value={anonymizeReason}
                  onChange={(event) => setAnonymizeReason(event.target.value)}
                >
                  <option value="">Elige un motivo</option>
                  {ANONYMIZE_REASONS.map((reason) => (
                    <option key={reason.value} value={reason.value}>
                      {reason.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </ConfirmAction>
        ) : null}
      </div>
    </section>
  );
}
