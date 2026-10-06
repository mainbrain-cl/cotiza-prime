-- Migración 22 — Correos enviados y respuestas del cliente (sprint 3, M21)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261006110000_email_messages_and_responses.down.sql
-- Especificación: docs/arquitectura/sprint-3-envio-y-enlace.md §1 (M21).
--
-- Ninguna de las dos tablas se escribe directo: no hay permisos de insert/update/delete para
-- `authenticated`. Escriben las funciones de las migraciones 23 a 25.

-- 1. email_messages --------------------------------------------------------------------------
create table public.email_messages (
  id                  uuid primary key,   -- lo genera la aplicación (también es la clave anti duplicado del proveedor)
  tenant_id           uuid not null references public.tenants (tenant_id) on update cascade,
  quote_id            uuid not null,
  package_id          uuid not null,
  share_link_id       uuid,               -- los avisos internos no llevan enlace
  kind                text not null check (kind in ('quote', 'quote_resend', 'internal_notice', 'payment_1', 'payment_2')),
  to_email_enc        text not null check (char_length(to_email_enc) between 1 and 2000),
  to_email_hash       text not null check (to_email_hash ~ '^[0-9a-f]{64}$'),
  provider            text not null check (provider ~ '^[a-z0-9_]{2,30}$'),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) between 1 and 200),
  status              text not null default 'pending'
                      check (status in ('pending', 'sent', 'delivered', 'bounced', 'complained', 'failed')),
  status_at           timestamptz not null default now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  bounced_at          timestamptz,
  bounce_type         text check (bounce_type in ('hard', 'soft')),
  error_code          text check (error_code is null or error_code ~ '^[A-Za-z0-9_.:-]{1,60}$'),   -- sin datos personales
  created_by          uuid references auth.users (id),   -- nulo cuando lo envía el sistema
  created_at          timestamptz not null default now(),
  constraint email_messages_bounce_shape check ((status = 'bounced') = (bounce_type is not null)),
  unique (tenant_id, id),
  foreign key (tenant_id, quote_id)      references public.quotes (tenant_id, id),
  foreign key (tenant_id, package_id)    references public.quote_packages (tenant_id, id),
  foreign key (tenant_id, share_link_id) references public.share_links (tenant_id, id)
);
-- Un solo correo "cotización" por paquete: así un doble clic nunca manda dos.
create unique index email_messages_one_quote_per_package on public.email_messages (tenant_id, package_id)
  where kind = 'quote';
-- El aviso del proveedor se busca por su identificador (único por proveedor).
create unique index email_messages_provider_id on public.email_messages (provider, provider_message_id)
  where provider_message_id is not null;
create index email_messages_quote on public.email_messages (tenant_id, quote_id, created_at);
create index email_messages_bounced on public.email_messages (tenant_id, status) where status = 'bounced';
create index email_messages_link on public.email_messages (tenant_id, share_link_id) where share_link_id is not null;

-- Lo que cambia es solo el estado y lo que el proveedor informa. El estado avanza en un orden y no
-- retrocede: pending < sent < delivered < (bounced | complained); `failed` solo sale de `pending`.
create function app.email_messages_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  c_moving constant text[] := array['status', 'status_at', 'sent_at', 'delivered_at', 'bounced_at',
                                    'bounce_type', 'error_code', 'provider', 'provider_message_id'];
  v_new jsonb;
  v_old jsonb;
  v_key text;
  v_rank_old integer;
  v_rank_new integer;
begin
  if tg_op = 'DELETE' then
    raise exception 'email_messages is append-only' using errcode = '42501';
  end if;
  v_new := to_jsonb(new);
  v_old := to_jsonb(old);
  for v_key in select k from jsonb_object_keys(v_new) k loop
    if v_key = any (c_moving) then
      continue;
    end if;
    if v_new -> v_key is distinct from v_old -> v_key then
      raise exception 'email_messages.% is immutable', v_key using errcode = '42501';
    end if;
  end loop;
  -- El proveedor se conoce al enviar: nace como 'pending' y se fija una sola vez.
  if old.provider <> 'pending' and new.provider is distinct from old.provider then
    raise exception 'provider is fixed once known' using errcode = '42501';
  end if;
  if old.provider_message_id is not null and new.provider_message_id is distinct from old.provider_message_id then
    raise exception 'provider_message_id is fixed once known' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    v_rank_old := case old.status when 'pending' then 0 when 'sent' then 1 when 'delivered' then 2
                    when 'bounced' then 3 when 'complained' then 3 else 9 end;
    v_rank_new := case new.status when 'pending' then 0 when 'sent' then 1 when 'delivered' then 2
                    when 'bounced' then 3 when 'complained' then 3 else 9 end;
    if not (
         (new.status = 'failed' and old.status = 'pending')
      or (new.status <> 'failed' and v_rank_old < 3 and v_rank_new > v_rank_old)) then
      raise exception 'invalid email status change % -> %', old.status, new.status using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger email_messages_guard before update or delete on public.email_messages
  for each row execute function app.email_messages_guard();
create trigger email_messages_no_truncate before truncate on public.email_messages
  for each statement execute function app.forbid_mutation();
create trigger email_messages_forbid_tenant_change before update on public.email_messages
  for each row execute function app.forbid_tenant_change();

-- Cierra el círculo con share_links (cada enlace nace con su correo). Se revisa al confirmar la
-- transacción, porque las dos filas se insertan juntas.
alter table public.share_links
  add constraint share_links_email_message_fk
  foreign key (tenant_id, email_message_id) references public.email_messages (tenant_id, id)
  deferrable initially deferred;

-- 2. quote_responses (registro de conformidad; solo agregar) ---------------------------------
create table public.quote_responses (
  id                      uuid primary key,   -- lo genera la aplicación (va en el sello de lo cifrado)
  tenant_id               uuid not null references public.tenants (tenant_id) on update cascade,
  quote_id                uuid not null,
  package_id              uuid not null,
  share_link_id           uuid not null,
  decision                text not null check (decision in ('accepted', 'rejected')),
  response_key            uuid not null,
  acceptor_name_enc       text,
  reason_code             text check (reason_code in ('price_too_high', 'not_in_budget', 'chose_other_provider',
                                                      'timing', 'no_longer_needed', 'other')),
  reason_text_enc         text,
  package_content_sha256  text not null check (package_content_sha256 ~ '^[0-9a-f]{64}$'),
  acceptance_text_version text check (acceptance_text_version is null or char_length(acceptance_text_version) between 1 and 40),
  ip_enc                  text,
  user_agent_short        text check (user_agent_short is null or char_length(user_agent_short) <= 120),
  responded_at            timestamptz not null default now(),
  -- Aceptar exige el nombre y la versión del texto aceptado; rechazar exige el motivo (y el texto si es "otro").
  constraint quote_responses_accept_shape check (
    decision <> 'accepted'
    or (acceptor_name_enc is not null and acceptance_text_version is not null
        and reason_code is null and reason_text_enc is null)),
  constraint quote_responses_reject_shape check (
    decision <> 'rejected'
    or (reason_code is not null
        and ((reason_code = 'other') = (reason_text_enc is not null))
        and acceptor_name_enc is null)),
  -- Una sola respuesta por cotización: la primera gana.
  unique (tenant_id, quote_id),
  unique (tenant_id, id),
  unique (share_link_id, response_key),
  foreign key (tenant_id, quote_id)      references public.quotes (tenant_id, id),
  foreign key (tenant_id, package_id)    references public.quote_packages (tenant_id, id),
  foreign key (tenant_id, share_link_id) references public.share_links (tenant_id, id)
);
create index quote_responses_link on public.quote_responses (tenant_id, share_link_id);

create trigger quote_responses_no_update   before update   on public.quote_responses for each row       execute function app.forbid_mutation();
create trigger quote_responses_no_delete   before delete   on public.quote_responses for each row       execute function app.forbid_mutation();
create trigger quote_responses_no_truncate before truncate on public.quote_responses for each statement execute function app.forbid_mutation();
create trigger quote_responses_forbid_tenant_change before update on public.quote_responses
  for each row execute function app.forbid_tenant_change();

-- 3. RLS y permisos --------------------------------------------------------------------------
alter table public.email_messages  enable row level security;
alter table public.quote_responses enable row level security;

create policy email_messages_select on public.email_messages for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
create policy quote_responses_select on public.quote_responses for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
-- Sin políticas ni permisos de escritura: solo las funciones y el servidor.

grant select on public.email_messages to authenticated;
-- La IP cifrada y el navegador de quien respondió no los lee ningún pase (son del registro de conformidad).
grant select (id, tenant_id, quote_id, package_id, share_link_id, decision, response_key, acceptor_name_enc,
              reason_code, reason_text_enc, package_content_sha256, acceptance_text_version, responded_at)
  on public.quote_responses to authenticated;
