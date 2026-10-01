-- Migración 8 — Clientes, con datos personales cifrados en la aplicación
-- Especificación: docs/arquitectura/modelo-datos.md §3.5 y §5 (H-022).
-- La base nunca tiene la clave: guarda texto cifrado (*_enc) y huellas (*_hash) para buscar.

create table public.customers (
  id            uuid primary key,   -- lo genera la aplicación ANTES de cifrar (va en el AAD, §5.3)
  tenant_id     uuid not null default app.current_tenant_id()
                references public.tenants (tenant_id) on update cascade,
  kind          text not null check (kind in ('person', 'company')),
  display_name  text not null check (char_length(display_name) between 1 and 200),   -- sin cifrar: se busca por partes
  email_enc     text,   -- 'v1.<iv>.<cifrado+etiqueta>' en base64url
  email_hash    text check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$'),
  phone_enc     text,
  rut_enc       text,
  rut_hash      text check (rut_hash is null or rut_hash ~ '^[0-9a-f]{64}$'),
  address_enc   text,
  anonymized_at timestamptz,   -- H-107: supresión = anonimizar, no borrar
  created_by    uuid references auth.users (id),
  updated_by    uuid references auth.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  check ((email_enc is null) = (email_hash is null)),
  check ((rut_enc   is null) = (rut_hash   is null))
);
create index customers_tenant_name on public.customers (tenant_id, display_name);
create index customers_name_trgm   on public.customers
  using gin (tenant_id, display_name extensions.gin_trgm_ops);
-- Duplicados: se avisa, no se impide (H-022), por eso los índices de huella no son únicos.
create index customers_tenant_email_hash on public.customers (tenant_id, email_hash) where email_hash is not null;
create index customers_tenant_rut_hash   on public.customers (tenant_id, rut_hash)   where rut_hash   is not null;

create trigger customers_meta   before insert or update on public.customers
  for each row execute function app.set_row_meta_by();
create trigger customers_forbid_tenant_change before update on public.customers
  for each row execute function app.forbid_tenant_change();
-- Datos personales: la auditoría guarda solo los nombres de los campos que cambiaron.
create trigger customers_audit  after insert or update on public.customers
  for each row execute function app.audit_row_change('keys_only', 'customer');

alter table public.customers enable row level security;

create policy customers_select on public.customers for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
create policy customers_insert on public.customers for insert to authenticated
  with check (tenant_id = (select app.current_tenant_id())
              and (select app.has_role('owner', 'admin', 'sales')));
create policy customers_update on public.customers for update to authenticated
  using      (tenant_id = (select app.current_tenant_id())
              and (select app.has_role('owner', 'admin', 'sales')))
  with check (tenant_id = (select app.current_tenant_id()));
-- sin política de delete: se anonimiza, no se borra

grant select on public.customers to authenticated;
grant insert (id, tenant_id, kind, display_name, email_enc, email_hash, phone_enc, rut_enc, rut_hash, address_enc)
  on public.customers to authenticated;
grant update (kind, display_name, email_enc, email_hash, phone_enc, rut_enc, rut_hash, address_enc)
  on public.customers to authenticated;
