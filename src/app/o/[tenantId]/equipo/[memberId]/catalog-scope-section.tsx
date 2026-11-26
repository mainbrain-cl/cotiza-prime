import { CatalogScopeForm } from "@/components/team/catalog-scope-form";
import type { ActiveTenant } from "@/lib/tenant/active-tenant";
import { notLimitableNote, roleCanBeLimited } from "@/lib/team/catalog-scope-model";
import { loadCatalogScope } from "@/lib/team/catalog-scope-queries";

/**
 * La sección «Servicios que puede cotizar» de la ficha de un miembro (H-042). Quien llega aquí ya pasó por `pagePermission(active,
 * "team.manage")`: las tablas de la regla solo las lee quien maneja el equipo. A un rol que no se limita (Dueño, Administrador, Aprobador,
 * Observador) no se le ofrecen controles, solo se dice por qué (y si quedó una lista guardada de antes).
 */
export async function CatalogScopeSection({
  active,
  memberId,
  memberName,
  role,
}: {
  active: ActiveTenant;
  memberId: string;
  memberName: string;
  role: string;
}) {
  // A un rol al que no se le limita no se le lee el catálogo (no hay lista que mostrar): solo si quedó una regla guardada.
  const limitable = roleCanBeLimited(role);
  const lookup = await loadCatalogScope(active, memberId, { withCatalog: limitable });
  if (lookup.status === "error") {
    return (
      <section
        aria-label="Servicios que puede cotizar"
        data-testid="catalog-scope"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
      >
        <h2 className="text-lg">Servicios que puede cotizar</h2>
        <p
          role="alert"
          data-testid="catalog-scope-error"
          className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm font-medium text-danger"
        >
          No pudimos cargar los servicios. Recarga la página en unos minutos.
        </p>
      </section>
    );
  }
  if (!limitable) {
    return (
      <section
        aria-label="Servicios que puede cotizar"
        data-testid="catalog-scope"
        className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5"
      >
        <h2 className="text-lg">Servicios que puede cotizar</h2>
        <p data-testid="catalog-scope-not-limitable" className="text-fg-muted">
          {notLimitableNote(role, lookup.scope.mode === "list")}
        </p>
      </section>
    );
  }
  return (
    <CatalogScopeForm
      tenantId={active.tenantId}
      memberId={memberId}
      memberName={memberName}
      initial={lookup.scope}
      catalog={lookup.catalog}
      catalogTruncated={lookup.catalogTruncated}
    />
  );
}
