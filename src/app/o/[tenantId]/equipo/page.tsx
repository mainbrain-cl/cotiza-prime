import { MailPlus } from "lucide-react";
import type { Metadata } from "next";
import { InvitationList, type InvitationItem } from "@/components/team/invitation-list";
import { InviteForm, type RoleChoice } from "@/components/team/invite-form";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatDateTime } from "@/lib/format-date";
import {
  GRANTABLE_ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  roleLabel,
} from "@/lib/permissions/matrix";
import { pagePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { INVITATION_MAX_PENDING, resendsLeft } from "@/lib/team/invitations-model";
import { loadInvitations } from "@/lib/team/queries";

export const metadata: Metadata = { title: "Tu equipo · Cotiza Prime" };

const ROLE_CHOICES: RoleChoice[] = GRANTABLE_ROLES.map((role) => ({
  value: role,
  label: ROLE_LABELS[role],
  description: ROLE_DESCRIPTIONS[role],
}));

export default async function TeamPage({ params }: PageProps<"/o/[tenantId]/equipo">) {
  const active = await requireActiveTenant((await params).tenantId);
  // Antes de leer cualquier dato: quien no maneja el equipo ve «No tienes permiso» y nada más.
  const denied = pagePermission(active, "team.manage");
  if (denied) return denied;

  const list = await loadInvitations(active);
  const items: InvitationItem[] = list.ok
    ? list.rows.map((row) => ({
        id: row.id,
        email: row.email,
        roleLabel: roleLabel(row.role),
        statusLabel: row.display.label,
        tone: row.display.tone,
        needsAttention: row.display.needsAttention,
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
          Invita a las personas que trabajan contigo y elige qué puede hacer cada una.
        </p>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <section
          aria-labelledby="pending-title"
          className="order-2 flex min-w-0 flex-col gap-4 lg:order-1"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="pending-title" className="text-lg">
              Invitaciones pendientes
            </h2>
            {list.ok ? (
              <p data-testid="invitation-count" className="text-sm text-fg-muted">
                {items.length} de {INVITATION_MAX_PENDING}
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

        <div className="order-1 lg:sticky lg:top-6 lg:order-2">
          <InviteForm tenantId={active.tenantId} roles={ROLE_CHOICES} />
        </div>
      </div>
    </div>
  );
}
