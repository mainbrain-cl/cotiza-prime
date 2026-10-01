-- Migración 4 — Términos, privacidad y consentimiento
-- Tablas, trigger de registro (perfil + aceptaciones) y RPC de aceptación.
-- NO inserta filas en legal_documents: los textos los escribe otro agente y se insertan en una
-- migración posterior. Especificación: docs/arquitectura/modelo-datos.md §3.7.

create table public.legal_documents (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default app.platform_tenant_id()
                 references public.tenants (tenant_id) on update cascade
                 check (tenant_id = app.platform_tenant_id()),
  kind           text not null check (kind in ('terms', 'privacy')),
  version        text not null,                 -- '2026-10-01-preliminar'
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  published_at   timestamptz not null,
  is_current     boolean not null default false,
  unique (kind, version),
  unique (tenant_id, id)
);
create unique index legal_one_current on public.legal_documents (kind) where is_current;

create table public.legal_acceptances (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default app.platform_tenant_id()
              references public.tenants (tenant_id) on update cascade
              check (tenant_id = app.platform_tenant_id()),
  user_id     uuid not null references auth.users (id) on delete cascade,
  document_id uuid not null,
  accepted_at timestamptz not null default now(),
  context     text not null check (context in ('signup', 'reaccept')),
  origin_ip   inet,
  user_agent  text check (user_agent is null or char_length(user_agent) <= 300),
  unique (user_id, document_id),
  foreign key (tenant_id, document_id) references public.legal_documents (tenant_id, id)
);
create index legal_acceptances_tenant_user on public.legal_acceptances (tenant_id, user_id);

create trigger legal_documents_forbid_tenant_change  before update on public.legal_documents  for each row execute function app.forbid_tenant_change();
create trigger legal_acceptances_forbid_tenant_change before update on public.legal_acceptances for each row execute function app.forbid_tenant_change();
create trigger legal_acceptances_no_update before update on public.legal_acceptances for each row execute function app.forbid_mutation();

alter table public.legal_documents   enable row level security;
alter table public.legal_acceptances enable row level security;

-- Los documentos vigentes se leen también sin sesión (los muestra la pantalla de registro).
create policy legal_documents_select on public.legal_documents for select to anon, authenticated
  using (true);
grant select on public.legal_documents to anon, authenticated;

create policy legal_acceptances_select on public.legal_acceptances for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.legal_acceptances to authenticated;

-- Registro: crea el perfil y, solo si las versiones declaradas son las vigentes, las aceptaciones.
-- La pantalla de registro manda raw_user_meta_data = {"full_name": "...",
--   "accepted_legal": {"terms": "<versión>", "privacy": "<versión>"}}.
-- Si falta algo, la puerta de entrada (requireUser) obliga a aceptar en el primer ingreso.
create function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name     text;
  v_accepted jsonb;
  v_doc      record;
begin
  v_name := left(coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Usuario'
  ), 120);

  insert into public.profiles (user_id, full_name) values (new.id, v_name);

  begin
    v_accepted := new.raw_user_meta_data -> 'accepted_legal';
    if jsonb_typeof(v_accepted) = 'object' then
      for v_doc in
        select d.id, d.kind from public.legal_documents d
        where d.is_current and (v_accepted ->> d.kind) = d.version
      loop
        insert into public.legal_acceptances (user_id, document_id, context)
        values (new.id, v_doc.id, 'signup')
        on conflict (user_id, document_id) do nothing;
      end loop;
    end if;
  exception when others then
    null;   -- un metadato mal formado no debe impedir el registro
  end;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- "Acepta la nueva versión": registra la aceptación de todos los documentos vigentes.
create function public.accept_current_legal_documents() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_headers json := nullif(current_setting('request.headers', true), '')::json;
  v_ip      inet;
  v_count   integer;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  begin v_ip := nullif(v_headers ->> 'x-cp-client-ip', '')::inet;
  exception when others then v_ip := null; end;

  with ins as (
    insert into public.legal_acceptances (user_id, document_id, context, origin_ip, user_agent)
    select v_uid, d.id, 'reaccept', v_ip, left(nullif(v_headers ->> 'user-agent', ''), 300)
    from public.legal_documents d
    where d.is_current
    on conflict (user_id, document_id) do nothing
    returning 1
  )
  select count(*)::integer into v_count from ins;
  return v_count;
end $$;

revoke all on function public.accept_current_legal_documents() from public, anon;
grant execute on function public.accept_current_legal_documents() to authenticated;
