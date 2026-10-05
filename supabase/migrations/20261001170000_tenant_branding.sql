-- Migración 13 — Marca de la organización (H-007): colores, logo y bucket privado de Storage
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261001170000_tenant_branding.down.sql
--
-- Storage SÍ entrega a la base de datos las cabeceras del pedido (verificado el 2026-10-01 en
-- Supabase local): `request.headers` trae `x-cp-tenant-id`, así que las políticas de
-- `storage.objects` usan app.current_tenant_id() (que además confirma la membresía) igual que
-- las tablas. Aun así, el logo de una organización a la que no pertenece la persona activa se sirve
-- desde el servidor (src/app/api/v1/tenants/[tenantId]/logo), tras requireActiveTenant.

-- Marca en tenants --------------------------------------------------------------------------
alter table public.tenants
  add column brand_primary_color   text,
  add column brand_secondary_color text,
  add column logo_path             text;

alter table public.tenants
  add constraint tenants_brand_primary_color_hex
    check (brand_primary_color is null or brand_primary_color ~ '^#[0-9a-f]{6}$'),
  add constraint tenants_brand_secondary_color_hex
    check (brand_secondary_color is null or brand_secondary_color ~ '^#[0-9a-f]{6}$'),
  -- La ruta SIEMPRE empieza por el tenant_id de la propia fila (modelo-datos.md §4.7).
  add constraint tenants_logo_path_shape
    check (logo_path is null
           or logo_path ~ ('^' || tenant_id::text || '/logo-[0-9a-f]{12}\.(png|jpg|svg)$'));

-- El formato del correo de contacto se verifica también al editar (create_tenant ya lo hacía).
-- NOT VALID: no revisa filas antiguas, solo toda escritura nueva.
alter table public.tenants
  add constraint tenants_contact_email_format
    check (contact_email is null or contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') not valid;

grant update (brand_primary_color, brand_secondary_color, logo_path) on public.tenants to authenticated;

-- Bucket privado -------------------------------------------------------------------------------
-- Segunda barrera: Storage rechaza por su cuenta lo que pese más o no sea de estos tipos.
-- 1 MiB = 1048576 bytes: debe coincidir con LOGO_MAX_BYTES (src/lib/brand/logo.ts).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-logos', 'tenant-logos', false, 1048576, array['image/png', 'image/jpeg', 'image/svg+xml'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Políticas de storage.objects ---------------------------------------------------------------
-- Leer: cualquier miembro de la organización activa. Escribir y borrar: Dueño o Administrador.
-- Toda ruta es `{tenant_id}/{archivo}`: una sola carpeta, la de la organización activa.
create policy tenant_logos_select on storage.objects for select to authenticated
  using (
    bucket_id = 'tenant-logos'
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
  );

create policy tenant_logos_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'tenant-logos'
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
    and (select app.has_role('owner', 'admin'))
  );

create policy tenant_logos_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'tenant-logos'
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
    and (select app.has_role('owner', 'admin'))
  );
-- Sin política de UPDATE: nadie modifica ni mueve un archivo; se sube uno nuevo y se borra el viejo.
