-- Deshace 20261001170000_tenant_branding.sql
drop policy if exists tenant_logos_delete on storage.objects;
drop policy if exists tenant_logos_insert on storage.objects;
drop policy if exists tenant_logos_select on storage.objects;

-- Storage protege sus tablas contra borrados directos; este permiso vale solo para esta transacción.
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'tenant-logos';
delete from storage.buckets where id = 'tenant-logos';

revoke update (brand_primary_color, brand_secondary_color, logo_path) on public.tenants from authenticated;

alter table public.tenants
  drop constraint if exists tenants_contact_email_format,
  drop constraint if exists tenants_logo_path_shape,
  drop constraint if exists tenants_brand_secondary_color_hex,
  drop constraint if exists tenants_brand_primary_color_hex;
alter table public.tenants
  drop column if exists logo_path,
  drop column if exists brand_secondary_color,
  drop column if exists brand_primary_color;
