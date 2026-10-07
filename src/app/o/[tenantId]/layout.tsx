import { AppShell } from "@/components/app-shell/app-shell";
import { loadRequestBadge } from "@/lib/intake/requests-queries";
import { listMemberships, requireActiveTenant } from "@/lib/tenant/active-tenant";

export default async function TenantLayout({ children, params }: LayoutProps<"/o/[tenantId]">) {
  const { tenantId } = await params;
  // Quien no es miembro recibe "No encontrado" aquí, antes de dibujar nada.
  const active = await requireActiveTenant(tenantId);
  const memberships = await listMemberships(active.user.id);

  // Una consulta ligera para la insignia de «Solicitudes»; si falla, el menú no muestra número.
  const requestBadge = await loadRequestBadge(active);

  const { data: profile } = await active.supabase
    .from("profiles")
    .select("full_name")
    .eq("user_id", active.userId)
    .maybeSingle();

  return (
    <AppShell
      activeTenantId={active.tenantId}
      memberships={memberships}
      userName={(profile?.full_name as string | undefined) ?? active.user.email}
      badges={requestBadge ? { solicitudes: requestBadge } : {}}
    >
      {children}
    </AppShell>
  );
}
