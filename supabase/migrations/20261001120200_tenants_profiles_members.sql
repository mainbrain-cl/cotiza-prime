-- Migración 2 — Organizaciones, perfiles y miembros
-- Más la resolución de la organización activa (un solo punto: app.current_tenant_id()).
-- Especificación: docs/arquitectura/modelo-datos.md §2.4, §3.1–§3.3, §4.3.

-- tenants -----------------------------------------------------------------------------
create table public.tenants (
  tenant_id     uuid primary key default gen_random_uuid(),
  kind          text not null default 'organization' check (kind in ('organization', 'platform')),
  name          text not null check (char_length(name) between 2 and 120),
  rut           text,
  industry      text check (industry in ('logistics', 'services', 'products', 'construction', 'events', 'other')),
  contact_email text check (contact_email is null or char_length(contact_email) <= 254),
  contact_phone text check (contact_phone is null or char_length(contact_phone) <= 30),
  status        text not null default 'active' check (status in ('active', 'archived')),
  archived_at   timestamptz,
  created_by    uuid references auth.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint tenants_rut_required check (kind = 'platform' or rut is not null),
  constraint tenants_rut_valid    check (rut is null or app.is_valid_rut(rut))
);
create unique index tenants_one_platform on public.tenants (kind) where kind = 'platform';

-- Organización de la plataforma: dueña de los datos globales (perfiles, términos). Sin miembros.
insert into public.tenants (tenant_id, kind, name)
values (app.platform_tenant_id(), 'platform', 'Plataforma Cotiza Prime');

-- profiles ----------------------------------------------------------------------------
create table public.profiles (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  tenant_id      uuid not null default app.platform_tenant_id()
                 references public.tenants (tenant_id) on update cascade
                 check (tenant_id = app.platform_tenant_id()),
  full_name      text not null check (char_length(full_name) between 1 and 120),
  last_tenant_id uuid,   -- solo para redirigir al iniciar sesión; sin valor de seguridad
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- members -----------------------------------------------------------------------------
create table public.members (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (tenant_id) on update cascade,
  user_id    uuid not null references auth.users (id),   -- restrict: no se borra una cuenta con membresías
  role       text not null check (role in ('owner', 'admin', 'approver', 'sales', 'viewer')),
  status     text not null default 'active' check (status in ('active', 'removed')),
  invited_by uuid references auth.users (id),
  joined_at  timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id),
  unique (tenant_id, id),
  check ((status = 'removed') = (removed_at is not null))
);
create unique index members_one_owner   on public.members (tenant_id) where role = 'owner' and status = 'active';
create index        members_user_active on public.members (user_id, tenant_id) where status = 'active';

-- Resolución de la organización activa (§2.4) ----------------------------------------------
-- La aplicación manda la cabecera x-cp-tenant-id; PostgREST la deja en request.headers con
-- alcance de transacción. Se confirma SIEMPRE que la persona sea miembro activo. Si algo falla,
-- devuelve null y la RLS no muestra ninguna fila.
create function app.current_tenant_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_headers text := nullif(current_setting('request.headers', true), '');
  v_raw     text;
  v_tid     uuid;
begin
  if v_headers is null or auth.uid() is null then
    return null;
  end if;
  begin
    v_raw := nullif(v_headers::json ->> 'x-cp-tenant-id', '');
    v_tid := v_raw::uuid;
  exception when others then
    return null;
  end;
  if v_tid is null then
    return null;
  end if;
  if exists (
    select 1
    from public.members m
    join public.tenants t on t.tenant_id = m.tenant_id
    where m.tenant_id = v_tid
      and m.user_id   = auth.uid()
      and m.status    = 'active'
      and t.status    = 'active'
      and t.kind      = 'organization'
  ) then
    return v_tid;
  end if;
  return null;
end $$;

create function app.current_member_role() returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.members m
  where m.tenant_id = app.current_tenant_id()
    and m.user_id = auth.uid() and m.status = 'active'
$$;

create function app.has_role(variadic p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app.current_member_role() = any (p_roles), false)
$$;

-- Organizaciones de la persona (selector). Evita que la política de members se llame a sí misma.
create function app.my_tenant_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.tenant_id from public.members m
  where m.user_id = auth.uid() and m.status = 'active'
$$;

grant execute on function
  app.current_tenant_id(), app.current_member_role(), app.has_role(text[]), app.my_tenant_ids()
  to authenticated;

-- Triggers --------------------------------------------------------------------------------
create trigger tenants_meta   before insert or update on public.tenants  for each row execute function app.set_row_meta();
create trigger members_meta   before insert or update on public.members  for each row execute function app.set_row_meta();
create trigger profiles_meta  before insert or update on public.profiles for each row execute function app.set_row_meta();

create trigger tenants_forbid_tenant_change  before update on public.tenants  for each row execute function app.forbid_tenant_change();
create trigger members_forbid_tenant_change  before update on public.members  for each row execute function app.forbid_tenant_change();
create trigger profiles_forbid_tenant_change before update on public.profiles for each row execute function app.forbid_tenant_change();

-- RLS y permisos ----------------------------------------------------------------------------
alter table public.tenants  enable row level security;
alter table public.profiles enable row level security;
alter table public.members  enable row level security;

-- El selector necesita ver todas las organizaciones de la persona; los datos de negocio
-- se filtran solo por la organización activa.
create policy tenants_select on public.tenants for select to authenticated
  using (tenant_id in (select app.my_tenant_ids()));
create policy tenants_update on public.tenants for update to authenticated
  using      (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin')))
  with check (tenant_id = (select app.current_tenant_id()));
grant select on public.tenants to authenticated;
grant update (name, rut, industry, contact_email, contact_phone) on public.tenants to authenticated;

create policy members_select on public.members for select to authenticated
  using (user_id = (select auth.uid()) or tenant_id = (select app.current_tenant_id()));
grant select on public.members to authenticated;
-- Sin escritura directa: solo por RPC (create_tenant; invitaciones en el sprint 4).

create policy profiles_select on public.profiles for select to authenticated
  using (
    user_id = (select auth.uid())
    or user_id in (
      select m.user_id from public.members m
      where m.tenant_id = (select app.current_tenant_id()) and m.status = 'active'
    )
  );
create policy profiles_update on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select on public.profiles to authenticated;
grant update (full_name, last_tenant_id) on public.profiles to authenticated;
