-- Migración 21 — Paquete congelado, enlace del cliente y sus aperturas (sprint 3, M20)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261006100000_quote_packages_and_links.down.sql
-- Especificación: docs/arquitectura/sprint-3-envio-y-enlace.md §1 (M20).
--
-- Ninguna de estas tablas se escribe directo: no hay permisos de insert/update/delete para
-- `authenticated`. Escriben solo las funciones de las migraciones 23 y 24 (miembros) y 24 (portero).
-- Los archivos del bucket `quote-documents` los sube solo el servidor (llave maestra).
--
-- Desviación del plan, justificada: `unique (tenant_id, quote_id, send_key)` es parcial (solo
-- paquetes vivos). El plan pide que, con la misma clave, un paquete que quedó a medias se abandone y
-- se cree otro: con un único total, el segundo no podría insertarse.

-- 0. Constantes con nombre -------------------------------------------------------------------
-- Meses que se conservan las aperturas del enlace (PROYECTO.md §11.2: 12 meses; lo borra H-108).
create function app.share_views_retention_months() returns integer
language sql immutable as $$ select 12 $$;
revoke all on function app.share_views_retention_months() from public, anon, authenticated;

-- 1. quote_packages --------------------------------------------------------------------------
create table public.quote_packages (
  id                    uuid primary key,   -- lo genera la aplicación (va en la ruta del PDF)
  tenant_id             uuid not null references public.tenants (tenant_id) on update cascade,
  quote_id              uuid not null,
  state                 text not null default 'preparing'
                        check (state in ('preparing', 'ready', 'sent', 'failed', 'abandoned')),
  send_key              uuid not null,
  issue_date            date not null,
  valid_until           date not null,
  email_subject         text not null check (char_length(email_subject) between 1 and 150
                                             and email_subject !~ '[\r\n]'),
  email_body_md         text not null check (char_length(email_body_md) <= 5000),
  customer_snapshot_enc text not null check (char_length(customer_snapshot_enc) between 1 and 8000),
  document_snapshot     jsonb check (document_snapshot is null or pg_column_size(document_snapshot) <= 262144),
  pdf_path              text,
  pdf_sha256            text check (pdf_sha256 is null or pdf_sha256 ~ '^[0-9a-f]{64}$'),
  pdf_bytes             integer check (pdf_bytes is null or pdf_bytes between 1 and 20971520),
  logo_path             text,
  content_sha256        text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  created_by            uuid not null references auth.users (id),
  created_at            timestamptz not null default now(),
  constraint quote_packages_valid_after_issue check (valid_until >= issue_date),
  -- Las rutas son siempre {tenant}/{cotización}/{paquete}: nadie apunta a un archivo de otra organización.
  constraint quote_packages_pdf_path_shape check (
    pdf_path is null or pdf_path = tenant_id::text || '/' || quote_id::text || '/' || id::text || '.pdf'),
  constraint quote_packages_logo_path_shape check (
    logo_path is null
    or logo_path ~ ('^' || tenant_id::text || '/' || quote_id::text || '/' || id::text || '-logo\.(png|jpg|svg)$')),
  -- Listo o enviado: el documento está completo.
  constraint quote_packages_document_complete check (
    state not in ('ready', 'sent')
    or (pdf_path is not null and pdf_sha256 is not null and pdf_bytes is not null
        and document_snapshot is not null and content_sha256 is not null)),
  unique (tenant_id, id),
  foreign key (tenant_id, quote_id) references public.quotes (tenant_id, id)
);
create unique index quote_packages_send_key on public.quote_packages (tenant_id, quote_id, send_key)
  where state in ('preparing', 'ready', 'sent');
-- A lo más un paquete vivo por cotización.
create unique index quote_packages_one_live on public.quote_packages (tenant_id, quote_id)
  where state in ('preparing', 'ready', 'sent');
create index quote_packages_quote on public.quote_packages (tenant_id, quote_id, created_at desc);
-- Para la tarea de reconciliación (paquetes en `ready` que nunca se enviaron).
create index quote_packages_ready on public.quote_packages (tenant_id, created_at) where state = 'ready';

-- Solo agregar: el contenido congelado no cambia nunca. Lo único que se mueve es el estado y la
-- llegada, una sola vez, de los datos del PDF (mientras el paquete se prepara).
create function app.quote_packages_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  c_data_columns constant text[] :=
    array['pdf_path', 'pdf_sha256', 'pdf_bytes', 'logo_path', 'document_snapshot', 'content_sha256'];
  v_new jsonb;
  v_old jsonb;
  v_key text;
begin
  if tg_op = 'DELETE' then
    raise exception 'quote_packages is append-only' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'preparing' or new.pdf_path is not null or new.pdf_sha256 is not null
       or new.pdf_bytes is not null or new.logo_path is not null
       or new.document_snapshot is not null or new.content_sha256 is not null then
      raise exception 'a package starts empty and in preparing' using errcode = '42501';
    end if;
    return new;
  end if;

  v_new := to_jsonb(new);
  v_old := to_jsonb(old);
  for v_key in select k from jsonb_object_keys(v_new) k loop
    if v_key = 'state' or v_key = any (c_data_columns) then
      continue;
    end if;
    if v_new -> v_key is distinct from v_old -> v_key then
      raise exception 'quote_packages.% is immutable', v_key using errcode = '42501';
    end if;
  end loop;

  foreach v_key in array c_data_columns loop
    if v_new -> v_key is distinct from v_old -> v_key
       and (old.state <> 'preparing' or v_old -> v_key <> 'null'::jsonb) then
      raise exception 'quote_packages.% only fills in once, while preparing', v_key using errcode = '42501';
    end if;
  end loop;

  if new.state is distinct from old.state and not (
       (old.state = 'preparing' and new.state in ('ready', 'failed', 'abandoned'))
    or (old.state = 'ready'     and new.state in ('sent', 'failed', 'abandoned'))) then
    raise exception 'invalid package state change % -> %', old.state, new.state using errcode = '42501';
  end if;
  return new;
end $$;
create trigger quote_packages_guard before insert or update or delete on public.quote_packages
  for each row execute function app.quote_packages_guard();
create trigger quote_packages_no_truncate before truncate on public.quote_packages
  for each statement execute function app.forbid_mutation();
create trigger quote_packages_forbid_tenant_change before update on public.quote_packages
  for each row execute function app.forbid_tenant_change();

-- 2. Columnas nuevas de quotes ---------------------------------------------------------------
alter table public.quotes
  add column current_package_id uuid,
  add column send_lock_key     uuid,
  add column send_lock_until   timestamptz,
  add column first_viewed_at   timestamptz,
  add column responded_at      timestamptz,
  add constraint quotes_send_lock_pair check ((send_lock_key is null) = (send_lock_until is null)),
  add foreign key (tenant_id, current_package_id) references public.quote_packages (tenant_id, id);
create index quotes_expiry on public.quotes (valid_until) where status in ('sent', 'viewed');

-- Con el candado de envío vigente nadie guarda el borrador (así no se reescribe save_quote_draft).
create function app.quotes_send_lock_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.send_lock_until is not null and old.send_lock_until > now()
     and new.revision is distinct from old.revision then
    raise exception 'quote is being sent' using errcode = 'CP423';
  end if;
  return new;
end $$;
create trigger quotes_send_lock_guard before update on public.quotes
  for each row execute function app.quotes_send_lock_guard();

-- Lista cerrada de cambios de estado de esta etapa; los sprints siguientes la amplían.
create function app.quotes_status_transition_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'draft'  and new.status = 'sent')
    or (old.status = 'sent'   and new.status = 'viewed')
    or (old.status in ('sent', 'viewed') and new.status in ('accepted', 'rejected_by_customer', 'expired'))) then
    raise exception 'invalid quote status change % -> %', old.status, new.status using errcode = '42501';
  end if;
  return new;
end $$;
create trigger quotes_status_transition_guard before update of status on public.quotes
  for each row execute function app.quotes_status_transition_guard();

-- 3. share_links -----------------------------------------------------------------------------
create table public.share_links (
  id               uuid primary key,   -- lo genera la aplicación
  tenant_id        uuid not null references public.tenants (tenant_id) on update cascade,
  quote_id         uuid not null,
  package_id       uuid not null,
  email_message_id uuid not null,      -- la relación se agrega en la migración 22 (tabla email_messages)
  token_sha256     text not null check (token_sha256 ~ '^[0-9a-f]{64}$'),   -- el token solo vive en el correo
  activated_at     timestamptz,
  revoked_at       timestamptz,
  revoked_by       uuid references auth.users (id),
  revoke_reason    text check (revoke_reason in ('manual', 'failed_attempt', 'new_version')),
  first_viewed_at  timestamptz,
  last_viewed_at   timestamptz,
  view_count       integer not null default 0 check (view_count >= 0),
  created_at       timestamptz not null default now(),
  constraint share_links_revoked_pair check ((revoked_at is null) = (revoke_reason is null)),
  unique (tenant_id, id),
  foreign key (tenant_id, quote_id)   references public.quotes (tenant_id, id),
  foreign key (tenant_id, package_id) references public.quote_packages (tenant_id, id)
);
-- Único en toda la plataforma: el portero busca por sello sin saber la organización.
create unique index share_links_token on public.share_links (token_sha256);
create index share_links_quote on public.share_links (tenant_id, quote_id);
create index share_links_package on public.share_links (tenant_id, package_id);

-- Solo se mueven la activación, la revocación (una vez) y las aperturas.
create function app.share_links_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  c_moving constant text[] :=
    array['activated_at', 'revoked_at', 'revoked_by', 'revoke_reason', 'first_viewed_at', 'last_viewed_at', 'view_count'];
  v_new jsonb := to_jsonb(new);
  v_old jsonb := to_jsonb(old);
  v_key text;
begin
  if tg_op = 'DELETE' then
    raise exception 'share_links is append-only' using errcode = '42501';
  end if;
  for v_key in select k from jsonb_object_keys(v_new) k loop
    if v_key = any (c_moving) then
      continue;
    end if;
    if v_new -> v_key is distinct from v_old -> v_key then
      raise exception 'share_links.% is immutable', v_key using errcode = '42501';
    end if;
  end loop;
  if old.activated_at is not null and new.activated_at is distinct from old.activated_at then
    raise exception 'share link already activated' using errcode = '42501';
  end if;
  if old.revoked_at is not null
     and (new.revoked_at is distinct from old.revoked_at
          or new.revoked_by is distinct from old.revoked_by
          or new.revoke_reason is distinct from old.revoke_reason) then
    raise exception 'share link already revoked' using errcode = '42501';
  end if;
  if old.first_viewed_at is not null and new.first_viewed_at is distinct from old.first_viewed_at then
    raise exception 'first view is fixed' using errcode = '42501';
  end if;
  if new.view_count < old.view_count then
    raise exception 'view_count never goes down' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger share_links_guard before update or delete on public.share_links
  for each row execute function app.share_links_guard();
create trigger share_links_no_truncate before truncate on public.share_links
  for each statement execute function app.forbid_mutation();
create trigger share_links_forbid_tenant_change before update on public.share_links
  for each row execute function app.forbid_tenant_change();

-- 4. share_link_views (solo agregar; se limpia por plazo) ----------------------------------
create table public.share_link_views (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references public.tenants (tenant_id) on update cascade,
  share_link_id    uuid not null,
  viewed_at        timestamptz not null default now(),
  ip_enc           text,   -- sello 'share_link_views.ip|tenant|id'
  user_agent_short text check (user_agent_short is null or char_length(user_agent_short) <= 120),
  unique (tenant_id, id),
  foreign key (tenant_id, share_link_id) references public.share_links (tenant_id, id)
);
create index share_link_views_link on public.share_link_views (tenant_id, share_link_id, viewed_at);
-- Excepción justificada a "índice con tenant_id": la limpieza por plazo recorre todas las organizaciones.
create index share_link_views_retention on public.share_link_views (viewed_at);

-- Igual que audit_log: solo la función de retención, con app.retention_purge = 'on', y solo filas vencidas.
create function app.forbid_share_view_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('app.retention_purge', true) is not distinct from 'on'
     and old.viewed_at <= now() - make_interval(months => app.share_views_retention_months()) then
    return old;
  end if;
  raise exception 'share_link_views is append-only' using errcode = '42501';
end $$;
create trigger share_link_views_no_update   before update   on public.share_link_views for each row       execute function app.forbid_mutation();
create trigger share_link_views_no_delete   before delete   on public.share_link_views for each row       execute function app.forbid_share_view_delete();
create trigger share_link_views_no_truncate before truncate on public.share_link_views for each statement execute function app.forbid_mutation();
create trigger share_link_views_forbid_tenant_change before update on public.share_link_views
  for each row execute function app.forbid_tenant_change();

-- 5. RLS y permisos --------------------------------------------------------------------------
alter table public.quote_packages   enable row level security;
alter table public.share_links      enable row level security;
alter table public.share_link_views enable row level security;

create policy quote_packages_select on public.quote_packages for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
create policy share_links_select on public.share_links for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
create policy share_link_views_select on public.share_link_views for select to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin')));
-- Sin políticas ni permisos de escritura: solo las funciones y el servidor.

grant select on public.quote_packages to authenticated;
-- El sello del token es secreto: no se lee con un pase.
grant select (id, tenant_id, quote_id, package_id, email_message_id, activated_at, revoked_at, revoked_by,
              revoke_reason, first_viewed_at, last_viewed_at, view_count, created_at)
  on public.share_links to authenticated;
-- La IP cifrada y el navegador son datos personales de quien abrió el enlace: solo Dueño y Administrador
-- ven que hubo una apertura, y ni ellos ven la IP.
grant select (id, tenant_id, share_link_id, viewed_at) on public.share_link_views to authenticated;

-- 6. Bucket privado de documentos congelados --------------------------------------------------
-- 20 MiB = 20971520 bytes. Rutas: {tenant_id}/{quote_id}/{package_id}.pdf y ...-logo.{ext}.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quote-documents', 'quote-documents', false, 20971520,
        array['application/pdf', 'image/png', 'image/jpeg', 'image/svg+xml'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Los miembros de la organización activa solo leen. Nadie con sesión sube, edita ni borra: el servidor
-- (llave maestra) sube el archivo una vez y no se toca más.
create policy quote_documents_select on storage.objects for select to authenticated
  using (
    bucket_id = 'quote-documents'
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
  );

-- 7. Tope de intentos --------------------------------------------------------------------------
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant',
                   'share_ip', 'share_token', 'share_respond_ip', 'quote_send_user'));
