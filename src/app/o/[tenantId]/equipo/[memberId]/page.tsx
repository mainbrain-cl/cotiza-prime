import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { lockNote, RoleBadge } from "@/components/team/member-list";
import { MemberActions } from "@/components/team/member-actions";
import { pagePermission } from "@/lib/permissions/require";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { isUuid, tenantPath } from "@/lib/tenant/constants";
import { roleOptionsFor, toMemberItem } from "@/lib/team/members-model";
import { loadMember } from "@/lib/team/members-queries";

export const metadata: Metadata = { title: "Miembro del equipo · Cotiza Prime" };

/**
 * La ficha de un miembro (H-010): nombre, rol, ingreso, correo y las mismas acciones que la lista. Es una ficha
 * mínima: H-042 le agrega después su sección (los servicios que puede cotizar) debajo de los datos.
 *
 * Primero la organización activa, luego el permiso de equipo, y recién entonces se lee a la persona: quien no maneja
 * el equipo ve «No tienes permiso» sin que se consulte nada. Un miembro de otra organización, ya quitado o que no
 * existe da «No encontrado» sin revelar cuál de los casos es.
 */
export default async function MemberPage({ params }: PageProps<"/o/[tenantId]/equipo/[memberId]">) {
  const { tenantId, memberId } = await params;
  const active = await requireActiveTenant(tenantId);
  const denied = pagePermission(active, "team.manage");
  if (denied) return denied;
  if (!isUuid(memberId)) notFound();

  const lookup = await loadMember(active, memberId);
  if (lookup.status === "not_found") notFound();

  const teamPath = tenantPath(active.tenantId, "equipo");
  const back = (
    <Link
      href={teamPath}
      className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-fg-muted hover:text-fg"
    >
      <ChevronLeft aria-hidden className="size-4" />
      Tu equipo
    </Link>
  );

  if (lookup.status === "error") {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          {back}
          <h1 className="text-xl md:text-2xl">Miembro del equipo</h1>
        </header>
        <p
          role="alert"
          data-testid="member-error"
          className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm font-medium text-danger"
        >
          No pudimos cargar a esta persona. Recarga la página en unos minutos.
        </p>
      </div>
    );
  }

  const item = toMemberItem(lookup.member, active.tenantId, active.role);
  const note = lockNote(item);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        {back}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl md:text-2xl" data-testid="member-title">
            {item.displayName}
            {item.isSelf ? <span className="text-fg-subtle"> (tú)</span> : null}
          </h1>
          <RoleBadge label={item.roleLabel} owner={item.isOwner} />
        </div>
      </header>

      <section
        aria-label="Datos de la persona"
        data-testid="member-card"
        className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
      >
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-semibold tracking-[0.08em] text-fg-subtle uppercase">
              Correo
            </dt>
            <dd data-testid="member-email" className="min-w-0 break-all text-fg">
              {item.email ?? "Sin correo"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-semibold tracking-[0.08em] text-fg-subtle uppercase">
              Ingreso
            </dt>
            <dd data-testid="member-joined" className="text-fg">
              {item.joinedLabel}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:col-span-2">
            <dt className="text-xs font-semibold tracking-[0.08em] text-fg-subtle uppercase">
              Qué puede hacer
            </dt>
            <dd data-testid="member-role-description" className="text-fg-muted">
              {item.roleDescription}
            </dd>
          </div>
        </dl>

        {note ? (
          <p data-testid="member-lock-note" className="text-sm text-fg-subtle">
            {note}
          </p>
        ) : (
          <MemberActions
            tenantId={active.tenantId}
            memberId={item.memberId}
            memberName={item.displayName}
            role={item.role}
            roles={roleOptionsFor(active.role)}
            canChangeRole={item.canChangeRole}
            canRemove={item.canRemove}
            afterRemovePath={teamPath}
          />
        )}
      </section>

      {/* Aquí irá, con H-042, la sección «Servicios que puede cotizar». */}
    </div>
  );
}
