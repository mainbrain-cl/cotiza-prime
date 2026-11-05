import { MailPlus, Users } from "lucide-react";
import type { Metadata } from "next";
import { InvitationList, type InvitationItem } from "@/components/team/invitation-list";
import { InviteForm } from "@/components/team/invite-form";
import { MemberList } from "@/components/team/member-list";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatDateTime } from "@/lib/format-date";
import { roleLabel } from "@/lib/permissions/matrix";
import { pagePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { INVITATION_MAX_PENDING, resendsLeft } from "@/lib/team/invitations-model";
import {
  MEMBERS_HEADING_ID,
  ROLE_OPTIONS,
  roleOptionsFor,
  toMemberItem,
} from "@/lib/team/members-model";
import { loadMembers } from "@/lib/team/members-queries";
import { loadInvitations } from "@/lib/team/queries";

export const metadata: Metadata = { title: "Tu equipo · Cotiza Prime" };

export default async function TeamPage({ params }: PageProps<"/o/[tenantId]/equipo">) {
  const active = await requireActiveTenant((await params).tenantId);
  // Antes de leer cualquier dato: quien no maneja el equipo ve «No tienes permiso» y nada más.
  const denied = pagePermission(active, "team.manage");
  if (denied) return denied;

  const [members, list] = await Promise.all([loadMembers(active), loadInvitations(active)]);
  const memberItems = members.ok
    ? members.members.map((member) => toMemberItem(member, active.tenantId, active.role))
    : [];
  const items: InvitationItem[] = list.ok
    ? list.rows.map((row) => ({
        id: row.id,
        email: row.email,
        roleLabel: roleLabel(row.role),
        statusLabel: row.display.label,
        tone: row.display.tone,
        needsAttention: row.display.needsAttention,
        expired: row.display.expired,
        createdLabel: `Invitada el ${formatDate(row.createdAt)}`,
        expiresLabel: `${row.display.expired ? "Venció" : "Vence"} el ${formatDate(row.expiresAt)}`,
        sentLabel: `Último envío: ${formatDateTime(row.lastSentAt)}`,
        invitedBy: row.invitedByName,
        resendsLeft: resendsLeft(row.sendCount),
      }))
    : [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl md:text-2xl">Tu equipo</h1>
        <p className="text-fg-muted">
          Mira quién está en tu equipo, cambia lo que puede hacer cada persona e invita a quienes
          faltan.
        </p>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="order-2 flex min-w-0 flex-col gap-8 lg:order-1">
          <section aria-labelledby={MEMBERS_HEADING_ID} className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              {/* Tras quitar a alguien su fila desaparece: el foco vuelve aquí (`tabIndex` -1). */}
              <h2 id={MEMBERS_HEADING_ID} tabIndex={-1} className="text-lg">
                Miembros
              </h2>
              {members.ok ? (
                <p className="text-sm text-fg-muted">
                  <span data-testid="member-count">{memberItems.length}</span>{" "}
                  {memberItems.length === 1 ? "persona" : "personas"} en el equipo
                </p>
              ) : null}
            </div>

            {!members.ok ? (
              <p
                role="alert"
                data-testid="members-error"
                className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm font-medium text-danger"
              >
                No pudimos cargar a los miembros. Recarga la página en unos minutos.
              </p>
            ) : memberItems.length === 0 ? (
              <EmptyState
                icon={Users}
                title="Aún no hay miembros"
                description="Cuando alguien acepte una invitación, aparecerá aquí con su rol."
              />
            ) : (
              <MemberList
                tenantId={active.tenantId}
                items={memberItems}
                roles={roleOptionsFor(active.role)}
              />
            )}
          </section>

          <section aria-labelledby="pending-title" className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="pending-title" className="text-lg">
                Invitaciones pendientes
              </h2>
              {list.ok ? (
                <p className="text-sm text-fg-muted">
                  <span data-testid="invitation-count">
                    {items.length} de {INVITATION_MAX_PENDING}
                  </span>{" "}
                  permitidas a la vez
                </p>
              ) : null}
            </div>

            {!list.ok ? (
              <p
                role="alert"
                className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm font-medium text-danger"
              >
                No pudimos cargar las invitaciones. Recarga la página en unos minutos.
              </p>
            ) : items.length === 0 ? (
              <EmptyState
                icon={MailPlus}
                title="No hay invitaciones pendientes"
                description="Cuando invites a alguien, aparecerá aquí hasta que acepte. Escribe su correo y elige su rol en el formulario."
              />
            ) : (
              <InvitationList tenantId={active.tenantId} items={items} />
            )}
          </section>
        </div>

        <div className="order-1 lg:sticky lg:top-6 lg:order-2">
          <InviteForm tenantId={active.tenantId} roles={[...ROLE_OPTIONS]} />
        </div>
      </div>
    </div>
  );
}
