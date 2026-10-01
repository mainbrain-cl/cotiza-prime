import { AppShell } from "@/components/app-shell/app-shell";
import { listMemberships, requireActiveTenant } from "@/lib/tenant/active-tenant";

export default async function TenantLayout({ children, params }: LayoutProps<"/o/[tenantId]">) {
  const { tenantId } = await params;
  // Quien no es miembro recibe "No encontrado" aquí, antes de dibujar nada.
  const active = await requireActiveTenant(tenantId);
  const memberships = await listMemberships(active.user.id);

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
    >
      {children}
    </AppShell>
  );
}
