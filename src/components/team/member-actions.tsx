"use client";

import { UserCog, UserMinus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/intake/confirm-action";
import { Button } from "@/components/ui/button";
import { OfflineNotice } from "@/components/ui/offline-notice";
import { changeMemberRoleAction, removeMemberAction } from "@/lib/team/members-actions";
import type { RoleOption } from "@/lib/team/members-model";
import { cn } from "@/lib/utils";

const RESULT_TOAST_ID = "member-result";
const SAME_ROLE_MESSAGE = "Elige un rol distinto del actual.";

/** Lo que pasa al quitar a alguien, dicho en simple. La base de datos hace exactamente esto (`remove_member`). */
const REMOVAL_CONSEQUENCES = [
  "Sus cotizaciones siguen existiendo con su nombre.",
  "Sus borradores quedan solo para leer.",
  "Las invitaciones que envió se cancelan.",
  "Sus solicitudes asignadas quedan sin responsable.",
  "Para que vuelva, tendrás que invitar de nuevo a esa persona.",
];

type Props = {
  tenantId: string;
  memberId: string;
  memberName: string;
  /** El rol que la persona ve ahora: la base solo cambia si sigue siendo ese. */
  role: string;
  roles: RoleOption[];
  canChangeRole: boolean;
  canRemove: boolean;
  /** Si se indica, tras quitar a la persona se navega ahí (la ficha de alguien que ya no está no existe). */
  afterRemovePath?: string;
};

/**
 * «Cambiar rol» y «Quitar del equipo» de un miembro (H-010). Se usa igual en la lista y en la ficha. Cada acción
 * pide confirmación explicando qué pasa; si falla (sin conexión, el rol cambió, ya no está), el aviso sale en el
 * mismo diálogo y lo elegido no se pierde. El permiso real lo exigen el servidor y la base de datos: esta pantalla
 * solo ofrece los botones a quien corresponde.
 */
export function MemberActions({
  tenantId,
  memberId,
  memberName,
  role,
  roles,
  canChangeRole,
  canRemove,
  afterRemovePath,
}: Props) {
  const router = useRouter();
  if (!canChangeRole && !canRemove) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="member-actions">
      {canChangeRole ? (
        // La clave cambia con el rol: tras un cambio, la elección parte de nuevo desde el rol actual.
        <RoleChanger
          key={role}
          tenantId={tenantId}
          memberId={memberId}
          memberName={memberName}
          role={role}
          roles={roles}
        />
      ) : null}
      {canRemove ? (
        <ConfirmAction
          testId={`member-remove-${memberId}`}
          trigger={
            <Button type="button" variant="ghost" size="sm" data-testid="member-remove">
              <UserMinus aria-hidden />
              Quitar del equipo
            </Button>
          }
          title={`¿Quitar a ${memberName} del equipo?`}
          description="Perderá el acceso en su siguiente clic. Lo que hizo se conserva."
          confirmLabel="Sí, quitar"
          pendingLabel="Quitando…"
          onConfirm={async () => {
            const result = await removeMemberAction(tenantId, memberId, role);
            if (result.status !== "ok") return result.message;
            toast.success(result.message, { id: RESULT_TOAST_ID });
            // La ficha de quien se fue ya no existe: se va a la lista. En la lista, se refresca.
            if (afterRemovePath) router.push(afterRemovePath);
            else router.refresh();
            return null;
          }}
        >
          <OfflineNotice />
          <ul
            data-testid="member-remove-consequences"
            className="flex list-disc flex-col gap-1 pl-5 text-sm text-fg-muted"
          >
            {REMOVAL_CONSEQUENCES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </ConfirmAction>
      ) : null}
    </div>
  );
}

function RoleChanger({
  tenantId,
  memberId,
  memberName,
  role,
  roles,
}: {
  tenantId: string;
  memberId: string;
  memberName: string;
  role: string;
  roles: RoleOption[];
}) {
  const [selected, setSelected] = useState(role);
  return (
    <ConfirmAction
      testId={`member-role-${memberId}`}
      confirmVariant="primary"
      // Al cerrar sin confirmar, la elección vuelve al rol actual (no se recuerda lo que se canceló).
      onOpenChange={(open) => {
        if (!open) setSelected(role);
      }}
      trigger={
        <Button type="button" variant="secondary" size="sm" data-testid="member-change-role">
          <UserCog aria-hidden />
          Cambiar rol
        </Button>
      }
      title={`Cambiar el rol de ${memberName}`}
      description="Elige el rol nuevo. Se aplica en su siguiente clic."
      confirmLabel="Cambiar rol"
      pendingLabel="Cambiando…"
      onConfirm={async () => {
        if (selected === role) return SAME_ROLE_MESSAGE;
        const result = await changeMemberRoleAction(tenantId, memberId, selected, role);
        if (result.status !== "ok") return result.message;
        toast.success(result.message, { id: RESULT_TOAST_ID });
        return null;
      }}
    >
      <OfflineNotice />
      <fieldset className="flex flex-col gap-2" data-testid="member-role-choices">
        <legend className="sr-only">Rol nuevo de {memberName}</legend>
        {roles.map((option) => (
          <label
            key={option.value}
            data-testid={`member-role-option-${option.value}`}
            className={cn(
              "flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border-strong bg-surface p-3 transition-[border-color,background-color] duration-(--dur-fast) ease-ios hover:bg-surface-2",
              "has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30",
            )}
          >
            <input
              type="radio"
              name={`role-${memberId}`}
              value={option.value}
              checked={selected === option.value}
              onChange={() => setSelected(option.value)}
              className="mt-1 size-4 shrink-0 accent-(--accent)"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-semibold text-fg">
                {option.label}
                {option.value === role ? (
                  <span className="ml-2 text-xs font-medium text-fg-subtle">(rol actual)</span>
                ) : null}
              </span>
              <span className="text-sm text-fg-muted">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </ConfirmAction>
  );
}
