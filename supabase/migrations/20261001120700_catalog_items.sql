-- Migración 7 — Catálogo de servicios y productos
-- Especificación: docs/arquitectura/modelo-datos.md §3.4 (H-020, H-021).

create table public.catalog_items (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default app.current_tenant_id()
                 references public.tenants (tenant_id) on update cascade,
  name           text not null check (char_length(name) between 1 and 150),
  description    text check (description is null or char_length(description) <= 2000),
  unit           text not null check (unit in ('service', 'hour', 'km', 'm2', 'day', 'unit')),
  unit_price_clp bigint not null check (unit_price_clp >= 0),   -- neto, pesos enteros (P7)
  tax_treatment  text not null default 'taxable' check (tax_treatment in ('taxable', 'exempt')),
  is_active      boolean not null default true,                 -- H-021: desactivar, nunca borrar
  created_by     uuid references auth.users (id),
  updated_by     uuid references auth.users (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, id)
);
create index catalog_items_tenant_active_name on public.catalog_items (tenant_id, is_active, name);
create index catalog_items_name_trgm on public.catalog_items
  using gin (tenant_id, name extensions.gin_trgm_ops);

create trigger catalog_items_meta   before insert or update on public.catalog_items
  for each row execute function app.set_row_meta_by();
create trigger catalog_items_forbid_tenant_change before update on public.catalog_items
  for each row execute function app.forbid_tenant_change();
create trigger catalog_items_audit  after insert or update on public.catalog_items
  for each row execute function app.audit_row_change('diff', 'catalog_item');

alter table public.catalog_items enable row level security;

create policy catalog_items_select on public.catalog_items for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
create policy catalog_items_insert on public.catalog_items for insert to authenticated
  with check (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin')));
create policy catalog_items_update on public.catalog_items for update to authenticated
  using      (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin')))
  with check (tenant_id = (select app.current_tenant_id()));
-- sin política de delete: el catálogo se desactiva, nunca se borra

grant select on public.catalog_items to authenticated;
grant insert (id, tenant_id, name, description, unit, unit_price_clp, tax_treatment, is_active)
  on public.catalog_items to authenticated;
grant update (name, description, unit, unit_price_clp, tax_treatment, is_active)
  on public.catalog_items to authenticated;
