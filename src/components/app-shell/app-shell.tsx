import { LogOut } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { LegalFooter } from "@/components/legal/legal-footer";
import { LegalLinks } from "@/components/legal/legal-page";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/lib/auth/actions";
import { APP_ENV, isTestEnv } from "@/lib/env/app-env";
import type { MemberRole, Membership } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { MobileNav } from "./mobile-nav";
import { SidebarNav } from "./sidebar-nav";
import { TenantSwitcher } from "./tenant-switcher";

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: "Dueño",
  admin: "Administrador",
  approver: "Aprobador",
  sales: "Comercial",
  viewer: "Observador",
};

/**
 * Estructura de la aplicación (docs/DISENO.md, "Disposición"):
 * - Escritorio desde 1.280 px: barra lateral flotante de vidrio de 232 px.
 * - Tableta: la misma barra, contraída a íconos.
 * - Teléfono: selector arriba y barra inferior flotante.
 */
export function AppShell({
  activeTenantId,
  memberships,
  userName,
  children,
}: {
  activeTenantId: string;
  memberships: Membership[];
  userName: string;
  children: ReactNode;
}) {
  const basePath = tenantPath(activeTenantId);
  const switcherTenants = memberships.map((m) => ({
    tenantId: m.tenantId,
    name: m.name,
    roleLabel: ROLE_LABELS[m.role],
  }));

  return (
    <div
      className="flex flex-1 flex-col md:flex-row md:gap-4 md:p-4"
      // Sin la franja de pruebas (producción) no hay alto que descontar.
      style={isTestEnv(APP_ENV) ? undefined : ({ "--env-banner-height": "0px" } as CSSProperties)}
    >
      {/* Teléfono: organización activa arriba */}
      <header className="flex items-center gap-3 px-4 pt-4 md:hidden">
        <div className="min-w-0 flex-1">
          <TenantSwitcher activeTenantId={activeTenantId} tenants={switcherTenants} />
        </div>
      </header>

      {/* Tableta y escritorio: barra lateral flotante */}
      <aside
        aria-label="Barra lateral"
        className="sticky top-[calc(var(--env-banner-height)+1rem)] hidden h-[calc(100dvh-var(--env-banner-height)-2rem)] w-[72px] shrink-0 flex-col gap-4 rounded-lg p-2.5 glass md:flex xl:w-[232px] xl:p-3"
      >
        <BrandMark className="max-xl:justify-center" labelClassName="max-xl:sr-only" />
        <TenantSwitcher activeTenantId={activeTenantId} tenants={switcherTenants} collapsed />
        <SidebarNav basePath={basePath} />
        <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
          <p className="truncate px-1 text-xs text-fg-muted max-xl:sr-only" title={userName}>
            {userName}
          </p>
          <LegalLinks className="max-xl:hidden" />
          <form action={signOutAction}>
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="w-full justify-start max-xl:justify-center"
              title="Cerrar sesión"
            >
              <LogOut aria-hidden strokeWidth={1.75} />
              <span className="max-xl:sr-only">Cerrar sesión</span>
            </Button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main
          id="contenido"
          className="min-w-0 flex-1 px-4 pt-4 pb-6 md:px-4 md:pt-2 md:pb-8 xl:px-8"
        >
          {children}
        </main>
        {/* En escritorio los enlaces legales van en la barra lateral */}
        <LegalFooter className="pb-[calc(env(safe-area-inset-bottom)+5.5rem)] md:pb-3 xl:hidden" />
      </div>

      <MobileNav basePath={basePath} />
    </div>
  );
}
