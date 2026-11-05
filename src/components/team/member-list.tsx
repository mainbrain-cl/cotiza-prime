import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { MemberActions } from "@/components/team/member-actions";
import {
  MEMBER_OWNER_MESSAGE,
  MEMBER_SELF_MESSAGE,
  type MemberItem,
  type RoleOption,
} from "@/lib/team/members-model";
import { cn } from "@/lib/utils";

/** Insignia del rol: el del Dueño va con el acento, los demás en neutro. */
export function RoleBadge({ label, owner }: { label: string; owner: boolean }) {
  return (
    <span
      data-testid="member-role"
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap",
        owner ? "bg-accent-soft text-accent" : "bg-surface-2 text-fg-muted",
      )}
    >
      {label}
    </span>
  );
}

/** Por qué no hay botones sobre este miembro (solo el Dueño y uno mismo). */
export function lockNote(item: Pick<MemberItem, "isOwner" | "isSelf">): string | null {
  if (item.isOwner) return MEMBER_OWNER_MESSAGE;
  if (item.isSelf) return `Este eres tú. ${MEMBER_SELF_MESSAGE}`;
  return null;
}

/**
 * La lista de miembros activos de «Tu equipo» (H-010). En teléfono cada fila es una tarjeta. Los botones de cada
 * fila son los de `MemberActions`; el Dueño y la propia persona no tienen ninguno.
 */
export function MemberList({
  tenantId,
  items,
  roles,
}: {
  tenantId: string;
  items: MemberItem[];
  roles: RoleOption[];
}) {
  return (
    <ul aria-label="Miembros del equipo" className="grid gap-3" data-testid="member-list">
      {items.map((item) => {
        const note = lockNote(item);
        return (
          <li
            key={item.memberId}
            data-testid="member-row"
            data-member-id={item.memberId}
            className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-1"
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <Link
                  href={item.href}
                  data-testid="member-name"
                  className="inline-flex min-h-11 min-w-0 items-center gap-1 font-semibold break-words text-fg hover:text-accent md:min-h-0"
                >
                  {item.displayName}
                  {item.isSelf ? (
                    <span className="text-sm font-medium text-fg-subtle">(tú)</span>
                  ) : null}
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-subtle" />
                </Link>
                {item.email ? (
                  <p data-testid="member-email" className="min-w-0 text-sm break-all text-fg-muted">
                    {item.email}
                  </p>
                ) : null}
              </div>
              <RoleBadge label={item.roleLabel} owner={item.isOwner} />
            </div>

            <dl className="grid gap-x-6 gap-y-1 text-sm text-fg-muted sm:grid-cols-2">
              <div className="flex gap-1.5 sm:col-span-2">
                <dt className="sr-only">Qué puede hacer</dt>
                <dd data-testid="member-role-description">{item.roleDescription}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="sr-only">Ingreso</dt>
                <dd data-testid="member-joined">{item.joinedLabel}</dd>
              </div>
            </dl>

            {note ? (
              <p data-testid="member-lock-note" className="text-sm text-fg-subtle">
                {note}
              </p>
            ) : (
              <MemberActions
                tenantId={tenantId}
                memberId={item.memberId}
                memberName={item.displayName}
                role={item.role}
                roles={roles}
                canChangeRole={item.canChangeRole}
                canRemove={item.canRemove}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
