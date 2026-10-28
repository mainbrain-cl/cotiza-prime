-- Deshace 20261028100000_role_matrix.sql: las políticas vuelven a sus listas de roles escritas a mano
-- (audit_select vuelve a dejar leer al Administrador), has_role vuelve a leer el rol directo y se
-- borran las funciones nuevas. No toca datos.
alter policy audit_select on public.audit_log
  using (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin')));
alter policy intake_daily_counters_select on public.intake_daily_counters
  using (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin')));
alter policy share_link_views_select on public.share_link_views
  using (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin')));
alter policy tenant_logos_delete on storage.objects
  using (
    bucket_id = 'tenant-logos'
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
    and (select app.has_role('owner', 'admin'))
  );
alter policy tenants_update on public.tenants
  using (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin')));
alter policy customers_update on public.customers
  using (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin', 'sales')));
alter policy customers_insert on public.customers
  with check (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin', 'sales')));
alter policy catalog_items_update on public.catalog_items
  using (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin')));
alter policy catalog_items_insert on public.catalog_items
  with check (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin')));

create or replace function app.has_role(variadic p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app.current_member_role() = any (p_roles), false)
$$;

drop function if exists app.can(text, boolean);
drop function if exists app.effective_role();
drop function if exists app.role_can(text, text, boolean);
