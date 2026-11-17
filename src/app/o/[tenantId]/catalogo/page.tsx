import { Lock, Plus, Search, Tags } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/form-controls";
import {
  CATALOG_SEARCH_MAX_LENGTH,
  CATALOG_STATUS_FILTERS,
  parseCatalogStatusFilter,
  unitLabel,
} from "@/lib/catalog/schemas";
import { formatClp } from "@/lib/money/clp";
import { can } from "@/lib/permissions/matrix";
import { requireActiveTenant } from "@/lib/tenant/active-tenant";
import { tenantPath } from "@/lib/tenant/constants";
import { cn } from "@/lib/utils";
import { isValidMaxDiscountBp } from "@/lib/quotes/line-rules";
import { CatalogForm } from "./catalog-form";
import { DiscountCapForm } from "./discount-cap-form";

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
  price_locked: boolean;
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
  const status = parseCatalogStatusFilter((await searchParams).estado);

  // El filtro por organización lo pone la base (RLS) según la organización activa.
  let query = active.supabase
    .from("catalog_items")
    .select("id, name, description, unit, unit_price_clp, tax_treatment, is_active, price_locked")
    .order("name", { ascending: true })
    .limit(MAX_LISTED);
  if (search !== "") query = query.ilike("name", `%${escapeLike(search)}%`);
  if (status === "activos") query = query.eq("is_active", true);
  if (status === "inactivos") query = query.eq("is_active", false);
  const { data, error } = await query;
  const items = (data ?? []) as CatalogRow[];
  // El descuento máximo de los Comerciales (H-041): lo lee cualquier miembro. Si no se puede leer, la tarjeta no se muestra.
  const { data: tenantRow, error: capError } = await active.supabase
    .from("tenants")
    .select("max_discount_bp")
    .eq("tenant_id", active.tenantId)
    .maybeSingle();
  const maxDiscountBp = (tenantRow as { max_discount_bp: number | null } | null)?.max_discount_bp;
  const capReadable = !capError && tenantRow && isValidMaxDiscountBp(maxDiscountBp ?? null);
  const canEdit = can(active.role, "catalog.manage");
  const hasNoFilters = search === "" && status === "activos";
  // Catálogo realmente vacío: sin servicios de ningún tipo (ni siquiera desactivados).
  let isCatalogEmpty = false;
  if (!error && items.length === 0 && hasNoFilters) {
    const { count } = await active.supabase
      .from("catalog_items")
      .select("id", { count: "exact", head: true });
    isCatalogEmpty = (count ?? 0) === 0;
  }

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
        <div className="flex min-w-0 flex-col gap-6">
          {capReadable ? (
            <DiscountCapForm
              tenantId={active.tenantId}
              initialBp={maxDiscountBp ?? null}
              editable={canEdit}
            />
          ) : (
            <p
              role="alert"
              className="rounded-sm bg-danger-soft px-3 py-2.5 text-sm font-medium text-danger"
            >
              No pudimos leer el descuento máximo de los Comerciales. Recarga la página en unos
              minutos.
            </p>
          )}
          <section aria-label="Lista de servicios" className="flex min-w-0 flex-col gap-4">
            {error ? null : isCatalogEmpty ? (
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
                  {status !== "activos" ? (
                    <input type="hidden" name="estado" value={status} />
                  ) : null}
                </form>

                <nav aria-label="Filtrar por estado" className="flex flex-wrap gap-2">
                  {CATALOG_STATUS_FILTERS.map((filter) => {
                    const params = new URLSearchParams();
                    if (search !== "") params.set("q", search);
                    if (filter.value !== "activos") params.set("estado", filter.value);
                    const href = `${tenantPath(active.tenantId, "catalogo")}${
                      params.size > 0 ? `?${params}` : ""
                    }`;
                    const selected = filter.value === status;
                    return (
                      <Link
                        key={filter.value}
                        href={href}
                        aria-current={selected ? "true" : undefined}
                        className={cn(
                          "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold md:min-h-9",
                          selected
                            ? "border-accent bg-accent text-on-accent"
                            : "border-border-strong bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg",
                        )}
                      >
                        {filter.label}
                      </Link>
                    );
                  })}
                </nav>

                {items.length === 0 ? (
                  <p className="rounded-lg border border-border bg-surface px-6 py-10 text-center text-fg-muted">
                    {search !== ""
                      ? `No hay servicios que coincidan con “${search}”.`
                      : status === "inactivos"
                        ? "No tienes servicios desactivados."
                        : "No hay servicios activos. Puedes reactivar uno desde el filtro “Inactivos”."}
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
                            <p className="flex flex-wrap items-center gap-x-2 font-semibold text-fg">
                              <Link
                                href={tenantPath(active.tenantId, `catalogo/${item.id}`)}
                                className="inline-flex min-h-11 items-center hover:text-accent hover:underline md:min-h-0"
                              >
                                {item.name}
                              </Link>
                              {item.is_active ? null : (
                                <span className="rounded-full bg-surface-2 px-2 py-1 text-xs font-semibold text-fg-muted">
                                  Desactivado
                                </span>
                              )}
                            </p>
                            {item.description ? (
                              <p className="line-clamp-2 text-sm text-fg-muted">
                                {item.description}
                              </p>
                            ) : null}
                          </div>
                          <p className="flex items-center justify-end gap-1.5 text-right font-semibold text-fg tabular-nums md:order-last">
                            {item.price_locked ? (
                              <>
                                <Lock
                                  aria-hidden
                                  data-testid="price-lock-icon"
                                  className="size-4 shrink-0 text-fg-muted"
                                />
                                <span className="sr-only">Precio bloqueado</span>
                              </>
                            ) : null}
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
        </div>

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
