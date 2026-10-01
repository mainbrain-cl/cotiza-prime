-- Migración 5 — Numeración correlativa por organización
-- Especificación: docs/arquitectura/modelo-datos.md §6 (H-024, decisión 008).

create table public.numbering_settings (
  tenant_id    uuid primary key references public.tenants (tenant_id) on update cascade,
  prefix       text not null default 'COT' check (prefix ~ '^[A-Z0-9]{1,8}$'),
  mode         text not null default 'yearly' check (mode in ('yearly', 'continuous')),
  pad_width    smallint not null default 4 check (pad_width between 1 and 8),
  start_number bigint not null default 1 check (start_number >= 1),   -- lo que eligió, para mostrarlo
  updated_by   uuid references auth.users (id),
  updated_at   timestamptz not null default now()
);

create table public.numbering_sequences (
  tenant_id   uuid not null references public.tenants (tenant_id) on update cascade,
  scope       text not null check (scope = 'continuous' or scope ~ '^Y[0-9]{4}$'),   -- 'Y2026'
  last_number bigint not null check (last_number >= 0),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, scope)
);

-- El contador nunca baja, ni siquiera con la llave maestra
create function app.forbid_sequence_decrease() returns trigger
language plpgsql as $$
begin
  if new.last_number < old.last_number then
    raise exception 'numbering never goes back' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger numbering_sequences_monotonic before update on public.numbering_sequences
  for each row execute function app.forbid_sequence_decrease();
create trigger numbering_settings_meta  before insert or update on public.numbering_settings
  for each row execute function app.set_updated_at();
create trigger numbering_sequences_meta before insert or update on public.numbering_sequences
  for each row execute function app.set_updated_at();
create trigger numbering_settings_forbid_tenant_change  before update on public.numbering_settings
  for each row execute function app.forbid_tenant_change();
create trigger numbering_sequences_forbid_tenant_change before update on public.numbering_sequences
  for each row execute function app.forbid_tenant_change();
create trigger numbering_settings_audit after insert or update on public.numbering_settings
  for each row execute function app.audit_row_change('diff', 'numbering');

alter table public.numbering_settings  enable row level security;
alter table public.numbering_sequences enable row level security;

create policy numbering_settings_select on public.numbering_settings for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
create policy numbering_sequences_select on public.numbering_sequences for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
grant select on public.numbering_settings, public.numbering_sequences to authenticated;
-- Escritura: solo las funciones de abajo (y create_tenant).

-- Alcance del contador: 'continuous' o 'Y2026' (año calendario de America/Santiago)
create function app.numbering_scope(p_mode text, p_year integer) returns text
language sql immutable as $$
  select case p_mode when 'continuous' then 'continuous' else 'Y' || p_year::text end
$$;

-- Texto visible. OJO: lpad() CORTA si el número es más largo que el ancho
-- (lpad('12345', 4, '0') = '1234'); por eso se rellena solo cuando hace falta.
create function app.format_quote_number(p_prefix text, p_mode text, p_pad_width integer, p_year integer, p_seq bigint)
returns text
language sql immutable as $$
  select p_prefix || '-'
      || case p_mode when 'yearly' then p_year::text || '-' else '' end
      || case when length(p_seq::text) >= p_pad_width then p_seq::text
              else lpad(p_seq::text, p_pad_width, '0') end
$$;

create function app.current_business_year() returns integer
language sql stable as $$
  select extract(year from (now() at time zone app.business_timezone()))::integer
$$;

grant execute on function
  app.numbering_scope(text, integer), app.format_quote_number(text, text, integer, integer, bigint),
  app.current_business_year()
  to authenticated, service_role;

-- Asignación segura con varias personas a la vez (se usa desde el sprint 2, dentro de la
-- misma transacción que crea la cotización). Nadie la ejecuta directamente.
create function app.allocate_quote_number(p_tenant uuid, out seq bigint, out display text)
language plpgsql security definer set search_path = '' as $$
declare
  s       public.numbering_settings;
  v_year  integer := app.current_business_year();
  v_scope text;
begin
  if p_tenant is distinct from app.current_tenant_id() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into strict s from public.numbering_settings where tenant_id = p_tenant;
  v_scope := app.numbering_scope(s.mode, v_year);

  -- Un solo paso atómico: crea el contador si no existe o lo sube en 1, y bloquea la fila
  -- hasta que termine la transacción. Dos personas a la vez se ponen en fila, nunca chocan.
  insert into public.numbering_sequences as ns (tenant_id, scope, last_number)
  values (p_tenant, v_scope, 1)
  on conflict (tenant_id, scope) do update set last_number = ns.last_number + 1
  returning ns.last_number into seq;

  display := app.format_quote_number(s.prefix, s.mode, s.pad_width, v_year, seq);
end $$;
revoke all on function app.allocate_quote_number(uuid) from public, anon, authenticated;

-- Cambiar la configuración sin retroceder (§6.3). p_start_number = null conserva el próximo
-- número tal cual (útil para cambiar solo el prefijo o el ancho).
create function public.set_numbering(p_prefix text, p_mode text, p_start_number bigint default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant    uuid := app.current_tenant_id();
  s           public.numbering_settings;
  v_year      integer := app.current_business_year();
  v_cur_scope text;
  v_new_scope text;
  v_last_cur  bigint;
  v_last_new  bigint;
  v_min       bigint;
  v_start     bigint;
begin
  if v_tenant is null or not app.has_role('owner', 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_prefix is null or p_prefix !~ '^[A-Z0-9]{1,8}$' then
    raise exception 'El prefijo debe tener de 1 a 8 letras mayúsculas o números' using errcode = '22023';
  end if;
  if p_mode is null or p_mode not in ('yearly', 'continuous') then
    raise exception 'Formato de numeración inválido' using errcode = '22023';
  end if;

  select * into strict s from public.numbering_settings where tenant_id = v_tenant for update;

  v_cur_scope := app.numbering_scope(s.mode, v_year);
  v_new_scope := app.numbering_scope(p_mode, v_year);
  select coalesce(max(last_number), 0) into v_last_cur from public.numbering_sequences
    where tenant_id = v_tenant and scope = v_cur_scope;
  select coalesce(max(last_number), 0) into v_last_new from public.numbering_sequences
    where tenant_id = v_tenant and scope = v_new_scope;

  v_min   := greatest(v_last_new, v_last_cur) + 1;
  v_start := coalesce(p_start_number, v_min);
  if v_start < v_min then
    raise exception 'El próximo número no puede ser menor que %', v_min using errcode = '23514';
  end if;

  insert into public.numbering_sequences as ns (tenant_id, scope, last_number)
  values (v_tenant, v_new_scope, v_start - 1)
  on conflict (tenant_id, scope) do update
    set last_number = greatest(ns.last_number, excluded.last_number);

  update public.numbering_settings
     set prefix = p_prefix, mode = p_mode, start_number = v_start, updated_by = auth.uid()
   where tenant_id = v_tenant;

  return app.format_quote_number(p_prefix, p_mode, s.pad_width, v_year, v_start);
end $$;
revoke all on function public.set_numbering(text, text, bigint) from public, anon;
grant execute on function public.set_numbering(text, text, bigint) to authenticated;

-- H-024: "veo un ejemplo" del próximo número. Solo lectura; con los permisos de quien llama.
create function public.preview_next_quote_number() returns text
language plpgsql stable security invoker set search_path = '' as $$
declare
  s      public.numbering_settings;
  v_year integer := app.current_business_year();
  v_last bigint;
begin
  select * into s from public.numbering_settings
    where tenant_id = (select app.current_tenant_id());
  if not found then
    return null;
  end if;
  select coalesce(max(last_number), 0) into v_last from public.numbering_sequences
    where tenant_id = s.tenant_id and scope = app.numbering_scope(s.mode, v_year);
  return app.format_quote_number(s.prefix, s.mode, s.pad_width, v_year, v_last + 1);
end $$;
revoke all on function public.preview_next_quote_number() from public, anon;
grant execute on function public.preview_next_quote_number() to authenticated;
