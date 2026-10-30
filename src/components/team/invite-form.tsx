"use client";

import { MailPlus } from "lucide-react";
import { useActionState } from "react";
import { Field, FormAlert, Input, SubmitButton } from "@/components/ui/form-controls";
import { useResultToast } from "@/components/ui/use-result-toast";
import { INITIAL_FORM_STATE } from "@/lib/auth/form-state";
import { inviteMemberAction, type InviteFormState } from "@/lib/team/actions";
import { cn } from "@/lib/utils";

export type RoleChoice = { value: string; label: string; description: string };

/**
 * Formulario de invitar (H-008): el correo y el rol. Cada rol muestra, ANTES de elegirlo, una frase de qué
 * puede hacer. Las frases salen de la matriz de permisos (única fuente). El permiso real lo exige el
 * servidor y la base de datos; esta pantalla solo se muestra a quien maneja el equipo.
 */
export function InviteForm({ tenantId, roles }: { tenantId: string; roles: RoleChoice[] }) {
  const [state, formAction] = useActionState<InviteFormState, FormData>(
    inviteMemberAction.bind(null, tenantId),
    INITIAL_FORM_STATE,
  );
  useResultToast(state, { errors: false });
  const emailError = state.fieldErrors?.email;
  const roleError = state.fieldErrors?.role;
  const roleDescribedBy = roleError ? "invite-role-error" : undefined;

  return (
    <form
      action={formAction}
      noValidate
      data-testid="invite-form"
      // La clave cambia con cada resultado: tras un envío exitoso el formulario queda limpio.
      key={state.status === "sent" ? `sent-${state.message}` : "form"}
      className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-lg">Invitar a alguien</h2>
        <p className="text-sm text-fg-muted">
          Le enviamos un correo con un enlace para unirse. La invitación vale 7 días.
        </p>
      </div>

      {state.status === "error" && state.message ? <FormAlert>{state.message}</FormAlert> : null}

      <Field label="Correo de la persona" error={emailError} required>
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="persona@empresa.cl"
            defaultValue={state.values?.email ?? ""}
            data-testid="invite-email"
          />
        )}
      </Field>

      <fieldset className="flex flex-col gap-2" aria-describedby={roleDescribedBy}>
        <legend className="text-sm font-semibold text-fg">
          Rol{" "}
          <span aria-hidden className="text-danger">
            *
          </span>
        </legend>
        <div className="flex flex-col gap-2">
          {roles.map((role) => (
            <label
              key={role.value}
              data-testid={`invite-role-${role.value}`}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border-strong bg-surface p-3 transition-[border-color,background-color] duration-(--dur-fast) ease-ios hover:bg-surface-2",
                "has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30",
              )}
            >
              <input
                type="radio"
                name="role"
                value={role.value}
                defaultChecked={state.values?.role === role.value}
                className="mt-1 size-4 shrink-0 accent-(--accent)"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-semibold text-fg">{role.label}</span>
                <span className="text-sm text-fg-muted">{role.description}</span>
              </span>
            </label>
          ))}
        </div>
        {roleError ? (
          <p id="invite-role-error" role="alert" className="text-sm text-danger">
            {roleError}
          </p>
        ) : null}
      </fieldset>

      <SubmitButton pendingLabel="Enviando invitación…" data-testid="invite-submit">
        <MailPlus aria-hidden />
        Enviar invitación
      </SubmitButton>
    </form>
  );
}
