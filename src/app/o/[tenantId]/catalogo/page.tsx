import { Plus, Search, Tags } from "lucide-react";
import type { Metadata } from "next";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/form-controls";
import { CATALOG_SEARCH_MAX_LENGTH, unitLabel } from "@/lib/catalog/schemas";
import { formatClp } from "@/lib/money/clp";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { cn } from "@/lib/utils";
import { CatalogForm } from "./catalog-form";

export const metadata: Metadata = { title: "Catálogo · Cotiza Prime" };

const MAX_LISTED = 500;

type CatalogRow = {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  unit_price_clp: number;
  tax_treatment: "taxable" | "exempt";
  is_active: boolean;
};

/** Escapa los comodines de `ilike` para que "50%" se busque tal cual. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export default async function CatalogPage({
  params,
  searchParams,
}: PageProps<"/o/[tenantId]/catalogo">) {
  const active = await requireActiveTenant((await params).tenantId);
  const rawSearch = (await searchParams).q;
  const search = (typeof rawSearch === "string" ? rawSearch : "")
    .trim()
    .slice(0, CATALOG_SEARCH_MAX_LENGTH);

  // El filtro por organización lo pone la base (RLS) según la organización activa.
  let query = active.supabase
    .from("catalog_items")
    .select("id, name, description, unit, unit_price_clp, tax_treatment, is_active")
    .order("name", { ascending: true })
    .limit(MAX_LISTED);
  if (search !== "") query = query.ilike("name", `%${escapeLike(search)}%`);
  const { data, error } = await query;
  const items = (data ?? []) as CatalogRow[];
  const canEdit = active.role === "owner" || active.role === "admin";
  const isCatalogEmpty = items.length === 0 && search === "";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl md:text-2xl">Catálogo</h1>
          <p className="text-fg-muted">
            Tus servicios y productos, con el precio neto de cada uno.
          </p>
        </div>
        {canEdit ? (
          <a href="#agregar" className={cn(buttonVariants(), "lg:hidden")}>
            <Plus aria-hidden />
            Agregar
          </a>
        ) : null}
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm font-medium text-danger"
        >
          No pudimos cargar el catálogo. Recarga la página en unos minutos.
        </p>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] 2xl:grid-cols-[minmax(0,1fr)_28rem]">
        <section aria-label="Lista de servicios" className="flex min-w-0 flex-col gap-4">
          {isCatalogEmpty ? (
            <EmptyState
              icon={Tags}
              title="Tu catálogo está vacío"
              description={
                canEdit
                  ? "El catálogo es la lista de lo que vendes, con su precio neto (sin IVA). Al cotizar, el equipo elige de aquí y los precios se cargan solos. Agrega tu primer servicio con el formulario."
                  : "El catálogo es la lista de lo que vende tu organización, con su precio neto. Todavía no tiene servicios: un Administrador o el Dueño puede agregarlos."
              }
            />
          ) : (
            <>
              <form role="search" method="get" className="relative">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-fg-subtle"
                />
                <Input
                  type="search"
                  name="q"
                  aria-label="Buscar por nombre"
                  placeholder="Buscar por nombre"
                  defaultValue={search}
                  maxLength={CATALOG_SEARCH_MAX_LENGTH}
                  className="pl-10"
                />
              </form>

              {items.length === 0 ? (
                <p className="rounded-lg border border-border bg-surface px-6 py-10 text-center text-fg-muted">
                  No hay servicios que coincidan con &ldquo;{search}&rdquo;.
                </p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-1">
                  <div
                    aria-hidden
                    className="hidden grid-cols-[minmax(0,1fr)_9rem_9rem_8rem] gap-4 border-b border-border bg-surface-2 px-4 py-2.5 text-xs font-semibold text-fg-muted md:grid"
                  >
                    <span>Servicio</span>
                    <span>Unidad</span>
                    <span>IVA</span>
                    <span className="text-right">Precio neto</span>
                  </div>
                  <ul aria-label="Servicios del catálogo" className="divide-y divide-border">
                    {items.map((item) => (
                      <li
                        key={item.id}
                        data-testid="catalog-item"
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-4 py-3.5 md:grid-cols-[minmax(0,1fr)_9rem_9rem_8rem] md:items-center"
                      >
                        <div className="min-w-0">
                          <p className="font-semibold text-fg">{item.name}</p>
                          {item.description ? (
                            <p className="line-clamp-2 text-sm text-fg-muted">{item.description}</p>
                          ) : null}
                        </div>
                        <p className="text-right font-semibold text-fg tabular-nums md:order-last">
                          {formatClp(item.unit_price_clp)}
                        </p>
                        <p className="col-span-2 flex flex-wrap gap-x-2 text-sm text-fg-muted md:contents">
                          <span>{unitLabel(item.unit)}</span>
                          <span aria-hidden className="md:hidden">
                            ·
                          </span>
                          <span>
                            {item.tax_treatment === "taxable" ? "Afecto a IVA" : "Exento de IVA"}
                          </span>
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>

        {canEdit ? (
          <aside
            id="agregar"
            aria-labelledby="agregar-titulo"
            className="flex scroll-mt-20 flex-col gap-4 rounded-lg border border-border bg-surface p-5 shadow-1 lg:sticky lg:top-6"
          >
            <h2 id="agregar-titulo" className="text-lg">
              Agregar un servicio
            </h2>
            <CatalogForm tenantId={active.tenantId} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
