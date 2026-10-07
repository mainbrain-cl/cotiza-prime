import { LogOut } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { LegalFooter } from "@/components/legal/legal-footer";
import { Dock, DockItem } from "@/components/react-bits/dock";
import { signOutAction } from "@/lib/auth/actions";
import { logoUrl } from "@/lib/brand/logo";
import { APP_ENV, isTestEnv } from "@/lib/env/app-env";
import type { MemberRole, Membership } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { MobileNav } from "./mobile-nav";
import type { NavBadges } from "./nav-items";
import { PageTransition } from "./page-transition";
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
 * - Tableta y escritorio (desde 768 px): menú flotante vertical de vidrio pegado a la izquierda,
 *   de solo íconos con su nombre al lado al pasar el ratón o tabular (decisión 018: Dock de React Bits).
 * - Teléfono: selector arriba y barra inferior flotante.
 */
export function AppShell({
  activeTenantId,
  memberships,
  userName,
  badges = {},
  children,
}: {
  activeTenantId: string;
  memberships: Membership[];
  userName: string;
  /** Cuántas cosas esperan a la persona en cada destino del menú (hoy, solicitudes). */
  badges?: NavBadges;
  children: ReactNode;
}) {
  const basePath = tenantPath(activeTenantId);
  const switcherTenants = memberships.map((m) => ({
    tenantId: m.tenantId,
    name: m.name,
    roleLabel: ROLE_LABELS[m.role],
    logoUrl: logoUrl(m.tenantId, m.logoPath),
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

      {/* Tableta y escritorio: menú flotante vertical pegado a la izquierda (React Bits, decisión 018) */}
      <aside
        aria-label="Menú lateral"
        className="sticky top-[calc(var(--env-banner-height)+1rem)] z-30 hidden h-[calc(100dvh-var(--env-banner-height)-2rem)] w-[72px] shrink-0 md:flex"
      >
        <Dock className="flex size-full flex-col items-center gap-4 rounded-xl p-2 glass">
          <BrandMark compact />
          <TenantSwitcher activeTenantId={activeTenantId} tenants={switcherTenants} collapsed />
          <SidebarNav basePath={basePath} badges={badges} />
          <div className="mt-auto flex flex-col items-center gap-2 border-t border-border pt-3">
            <form action={signOutAction}>
              <DockItem
                type="submit"
                label="Cerrar sesión"
                hint={userName}
                icon={<LogOut aria-hidden strokeWidth={1.75} className="size-5" />}
              />
            </form>
          </div>
        </Dock>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main
          id="contenido"
          className="min-w-0 flex-1 px-4 pt-4 pb-6 md:px-4 md:pt-2 md:pb-8 xl:px-8"
        >
          <PageTransition>{children}</PageTransition>
        </main>
        <LegalFooter className="pb-[calc(env(safe-area-inset-bottom)+5.5rem)] md:pb-3" />
      </div>

      <MobileNav basePath={basePath} badges={badges} />
    </div>
  );
}
