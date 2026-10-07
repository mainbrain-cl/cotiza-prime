-- Migración 30 — Solicitudes del formulario público, contadores del día y avisos (sprint 4, M30)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261007110000_intake_requests.down.sql
-- Especificación: docs/arquitectura/sprint-4-formulario-publico.md §1 (M30).
--
-- Ninguna de las tablas se escribe directo: no hay permisos de insert/update/delete para `authenticated`.
-- Escriben solo las funciones de las migraciones 31 (servidor) y 32 (miembros).
--
-- Los datos de contacto de quien llena el formulario son datos personales de un desconocido: llegan
-- CIFRADOS desde la aplicación (sello `intake_requests.<campo>|tenant|id`; el id lo genera la aplicación
-- antes de cifrar), y el correo además con su huella para buscar duplicados entre clientes.
--
-- Desviaciones del plan, justificadas:
--  * `restore` (descartada → nueva) borra la asignación y el motivo del descarte: el plan fija la
--    transición `discarded → new`, y una solicitud «nueva» no puede quedar asignada. La historia de quién
--    descartó y por qué queda en la auditoría.
--  * `email_messages` gana también `intake_form_id`: el aviso «tu formulario llegó al tope de hoy» habla
--    de un formulario, no de una solicitud (la que se rechaza no se guarda).
--  * `email_messages_guard` deja borrar los avisos de solicitud (`request_assigned`, `request_received`)
--    solo durante la limpieza por plazo: sin eso, no se podría borrar una solicitud vencida que tiene avisos.
--  * El tope del contenido cifrado se acota por campo: el mensaje (≤2.000 caracteres, hasta 4 bytes cada
--    uno) admite hasta 12.000 caracteres cifrados; los demás, hasta 2.000.

-- 0. Constantes con nombre y ayudas puras -----------------------------------------------------
-- Plazos de conservación (PROYECTO.md §11.2 y plan del sprint 4, decisión 5).
create function app.intake_unconverted_retention_months() returns integer language sql immutable as $$ select 12 $$;
create function app.intake_discarded_retention_days()     returns integer language sql immutable as $$ select 30 $$;
create function app.intake_converted_anonymize_months()   returns integer language sql immutable as $$ select 12 $$;
create function app.intake_counters_retention_days()      returns integer language sql immutable as $$ select 90 $$;
-- Una solicitud lleva de 1 a 30 servicios y su copia no pasa de 16 kB.
create function app.intake_request_items_max()            returns integer language sql immutable as $$ select 30 $$;
create function app.intake_request_items_max_bytes()      returns integer language sql immutable as $$ select 16384 $$;
revoke all on function
  app.intake_unconverted_retention_months(), app.intake_discarded_retention_days(),
  app.intake_converted_anonymize_months(), app.intake_counters_retention_days(),
  app.intake_request_items_max(), app.intake_request_items_max_bytes()
  from public, anon, authenticated;

-- Un servicio de la copia congelada de la solicitud. Lista CERRADA de claves: no cabe ninguna clave de
-- precio ni de «estimado».
create function app.intake_request_item_valid(e jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(e) is distinct from 'object' then false
    when exists (select 1 from jsonb_object_keys(e) k
                  where k <> all (array['form_item_id', 'catalog_item_id', 'name', 'unit', 'quantity_milli'])) then false
    when jsonb_typeof(e -> 'form_item_id') is distinct from 'string' then false
    when not app.is_uuid_text(e ->> 'form_item_id') then false
    when coalesce(jsonb_typeof(e -> 'catalog_item_id'), 'null') not in ('null', 'string') then false
    when jsonb_typeof(e -> 'catalog_item_id') = 'string' and not app.is_uuid_text(e ->> 'catalog_item_id') then false
    when jsonb_typeof(e -> 'name') is distinct from 'string' then false
    when char_length(e ->> 'name') not between 1 and 150 then false
    when jsonb_typeof(e -> 'unit') is distinct from 'string' then false
    when (e ->> 'unit') <> all (array['service', 'hour', 'km', 'm2', 'day', 'unit']) then false
    when coalesce(jsonb_typeof(e -> 'quantity_milli'), 'null') <> 'null'
         and not app.calc_jsonb_int_in_range(e -> 'quantity_milli', app.intake_qty_min_milli(), app.intake_qty_max_milli()) then false
    else true
  end
$$;
create function app.intake_items_valid(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p) is distinct from 'array' then false
    when jsonb_array_length(p) not between 1 and app.intake_request_items_max() then false
    when octet_length(p::text) > app.intake_request_items_max_bytes() then false
    else not exists (select 1 from jsonb_array_elements(p) e where not app.intake_request_item_valid(e))
  end
$$;
grant execute on function app.intake_request_item_valid(jsonb), app.intake_items_valid(jsonb)
  to authenticated, service_role;

-- 1. intake_requests ---------------------------------------------------------------------------
create table public.intake_requests (
  id                        uuid primary key,   -- lo genera la aplicación ANTES de cifrar (va en el sello)
  tenant_id                 uuid not null references public.tenants (tenant_id) on update cascade,
  form_id                   uuid not null,
  status                    text not null default 'new' check (status in ('new', 'assigned', 'converted', 'discarded')),
  assigned_to               uuid references auth.users (id),
  assigned_at               timestamptz,
  assigned_by               uuid references auth.users (id),
  discard_reason            text check (discard_reason in ('spam', 'duplicate', 'out_of_scope', 'other')),
  discard_note              text check (discard_note is null or char_length(discard_note) <= 200),
  discarded_by              uuid references auth.users (id),
  discarded_at              timestamptz,
  quote_id                  uuid,
  converted_by              uuid references auth.users (id),
  converted_at              timestamptz,
  -- Datos de contacto cifrados (sello 'intake_requests.<campo>|tenant|id'); quedan en null al anonimizar.
  contact_name_enc          text check (contact_name_enc is null or char_length(contact_name_enc) between 1 and 2000),
  contact_email_enc         text check (contact_email_enc is null or char_length(contact_email_enc) between 1 and 2000),
  contact_phone_enc         text check (contact_phone_enc is null or char_length(contact_phone_enc) between 1 and 2000),
  company_enc               text check (company_enc is null or char_length(company_enc) between 1 and 2000),
  comuna_enc                text check (comuna_enc is null or char_length(comuna_enc) between 1 and 2000),
  service_address_enc       text check (service_address_enc is null or char_length(service_address_enc) between 1 and 2000),
  message_enc               text check (message_enc is null or char_length(message_enc) between 1 and 12000),
  contact_email_hash        text check (contact_email_hash is null or contact_email_hash ~ '^[0-9a-f]{64}$'),
  desired_date              date,
  -- Copia congelada de lo pedido: [{form_item_id, catalog_item_id, name, unit, quantity_milli}]. Sin precios.
  items                     jsonb not null check (app.intake_items_valid(items)),
  form_revision             integer not null check (form_revision >= 1),
  submit_key                uuid not null,
  -- Consentimiento: qué texto (versión y huella) se aceptó, cuándo y, si se guarda, desde qué IP (cifrada).
  consent_template_version  text not null check (char_length(consent_template_version) between 1 and 40),
  consent_text_sha256       text not null check (consent_text_sha256 ~ '^[0-9a-f]{64}$'),
  consented_at              timestamptz not null default now(),
  consent_ip_enc            text check (consent_ip_enc is null or char_length(consent_ip_enc) between 1 and 2000),
  anonymized_at             timestamptz,
  created_at                timestamptz not null default now(),
  -- Forma de cada estado.
  constraint intake_requests_assigned_trio check (
    (assigned_to is null) = (assigned_at is null) and (assigned_to is null) = (assigned_by is null)),
  constraint intake_requests_new_unassigned check (status <> 'new' or assigned_to is null),
  constraint intake_requests_assigned_has_assignee check (status <> 'assigned' or assigned_to is not null),
  constraint intake_requests_discard_shape check (
    (status = 'discarded') = (discard_reason is not null)
    and (discard_reason is null) = (discarded_by is null)
    and (discard_reason is null) = (discarded_at is null)
    and (discard_note is null or discard_reason is not null)),
  constraint intake_requests_convert_shape check (
    (status = 'converted') = (quote_id is not null)
    and (quote_id is null) = (converted_by is null)
    and (quote_id is null) = (converted_at is null)),
  -- Sin contacto solo si se anonimizó.
  constraint intake_requests_contact_present check (
    anonymized_at is not null
    or (contact_name_enc is not null and contact_email_enc is not null and contact_email_hash is not null)),
  unique (tenant_id, id),
  unique (tenant_id, form_id, submit_key),
  unique (tenant_id, quote_id),
  foreign key (tenant_id, form_id)  references public.intake_forms (tenant_id, id),
  foreign key (tenant_id, quote_id) references public.quotes (tenant_id, id)
);
create index intake_requests_status on public.intake_requests (tenant_id, status, created_at desc);
create index intake_requests_assignee on public.intake_requests (tenant_id, assigned_to, status);
create index intake_requests_email on public.intake_requests (tenant_id, contact_email_hash)
  where contact_email_hash is not null;
create index intake_requests_form on public.intake_requests (tenant_id, form_id, created_at);
-- Excepción justificada a «índice con tenant_id»: la limpieza por plazo recorre todas las organizaciones.
create index intake_requests_retention on public.intake_requests (created_at);

-- El contenido no cambia después de creado: solo los estados (por función, en una lista cerrada de
-- cambios) y, durante la limpieza por plazo, el vaciado de los datos de contacto de una solicitud ya
-- convertida. Solo la limpieza borra, y solo filas vencidas.
create function app.intake_requests_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c_moving constant text[] := array['status', 'assigned_to', 'assigned_at', 'assigned_by', 'discard_reason',
                                    'discard_note', 'discarded_by', 'discarded_at', 'quote_id', 'converted_by',
                                    'converted_at'];
  c_anonymized constant text[] := array['contact_name_enc', 'contact_email_enc', 'contact_phone_enc', 'company_enc',
                                        'comuna_enc', 'service_address_enc', 'message_enc', 'contact_email_hash',
                                        'consent_ip_enc', 'anonymized_at'];
  v_purge boolean := current_setting('app.retention_purge', true) is not distinct from 'on';
  v_new jsonb;
  v_old jsonb;
  v_key text;
  v_moved boolean := false;
begin
  if tg_op = 'DELETE' then
    if v_purge and (
         (old.status in ('new', 'assigned')
          and old.created_at <= now() - make_interval(months => app.intake_unconverted_retention_months()))
      or (old.status = 'discarded'
          and old.discarded_at <= now() - make_interval(days => app.intake_discarded_retention_days()))) then
      return old;
    end if;
    raise exception 'intake_requests is append-only' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'new' or new.anonymized_at is not null then
      raise exception 'a request starts new and with its contact data' using errcode = '42501';
    end if;
    return new;
  end if;

  v_new := to_jsonb(new);
  v_old := to_jsonb(old);
  for v_key in select k from jsonb_object_keys(v_new) k loop
    if v_key = any (c_moving) then
      if v_new -> v_key is distinct from v_old -> v_key then
        v_moved := true;
      end if;
      continue;
    end if;
    if v_key = any (c_anonymized) then
      -- Anonimizar: solo en la limpieza, solo una solicitud convertida con más de 12 meses, y solo vaciando.
      if v_new -> v_key is distinct from v_old -> v_key then
        if not (v_purge and old.status = 'converted' and old.anonymized_at is null
                and new.anonymized_at is not null
                and old.created_at <= now() - make_interval(months => app.intake_converted_anonymize_months())
                and (v_key = 'anonymized_at' or v_new -> v_key = 'null'::jsonb)) then
          raise exception 'intake_requests.% is immutable', v_key using errcode = '42501';
        end if;
      end if;
      continue;
    end if;
    if v_new -> v_key is distinct from v_old -> v_key then
      raise exception 'intake_requests.% is immutable', v_key using errcode = '42501';
    end if;
  end loop;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'new'      and new.status = 'assigned')
      or (old.status in ('new', 'assigned') and new.status in ('converted', 'discarded'))
      or (old.status = 'discarded' and new.status = 'new')) then
      raise exception 'invalid intake request status change % -> %', old.status, new.status using errcode = '42501';
    end if;
  elsif v_moved and old.status <> 'assigned' then
    -- Solo una solicitud asignada puede cambiar de responsable sin cambiar de estado.
    raise exception 'intake request in status % does not change', old.status using errcode = '42501';
  end if;
  return new;
end $$;
create trigger intake_requests_guard before insert or update or delete on public.intake_requests
  for each row execute function app.intake_requests_guard();
create trigger intake_requests_no_truncate before truncate on public.intake_requests
  for each statement execute function app.forbid_mutation();
create trigger intake_requests_forbid_tenant_change before update on public.intake_requests
  for each row execute function app.forbid_tenant_change();

-- 2. intake_daily_counters ---------------------------------------------------------------------
-- Cuántas solicitudes se aceptaron y cuántos envíos se bloquearon, por formulario y por día de Chile.
-- Los suma solo el servidor, dentro de la misma transacción del envío.
create table public.intake_daily_counters (
  tenant_id       uuid not null references public.tenants (tenant_id) on update cascade,
  form_id         uuid not null,
  day             date not null,
  accepted        integer not null default 0 check (accepted >= 0),
  blocked_captcha integer not null default 0 check (blocked_captcha >= 0),
  blocked_rate    integer not null default 0 check (blocked_rate >= 0),
  blocked_cap     integer not null default 0 check (blocked_cap >= 0),
  blocked_paused  integer not null default 0 check (blocked_paused >= 0),
  blocked_invalid integer not null default 0 check (blocked_invalid >= 0),
  cap_notified_at timestamptz,
  primary key (tenant_id, form_id, day),
  foreign key (tenant_id, form_id) references public.intake_forms (tenant_id, id)
);
-- Excepción justificada a «índice con tenant_id»: la limpieza por plazo recorre todas las organizaciones.
create index intake_daily_counters_retention on public.intake_daily_counters (day);
create trigger intake_daily_counters_forbid_tenant_change before update on public.intake_daily_counters
  for each row execute function app.forbid_tenant_change();

-- 3. RLS y permisos ----------------------------------------------------------------------------
alter table public.intake_requests       enable row level security;
alter table public.intake_daily_counters enable row level security;

-- Todos los miembros ven las solicitudes de su organización (con sus datos de contacto; plan §6).
create policy intake_requests_select on public.intake_requests for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));
-- Los contadores (envíos bloqueados y topes) solo los ven Dueño y Administrador.
create policy intake_daily_counters_select on public.intake_daily_counters for select to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.has_role('owner', 'admin')));

-- La IP cifrada del consentimiento no la lee ningún pase (es del registro de conformidad).
grant select (id, tenant_id, form_id, status, assigned_to, assigned_at, assigned_by, discard_reason,
              discard_note, discarded_by, discarded_at, quote_id, converted_by, converted_at,
              contact_name_enc, contact_email_enc, contact_phone_enc, company_enc, comuna_enc,
              service_address_enc, message_enc, contact_email_hash, desired_date, items, form_revision,
              submit_key, consent_template_version, consent_text_sha256, consented_at, anonymized_at,
              created_at)
  on public.intake_requests to authenticated;
grant select on public.intake_daily_counters to authenticated;

-- 4. Tope de intentos --------------------------------------------------------------------------
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant',
                   'share_ip', 'share_token', 'share_respond_ip', 'quote_send_user',
                   'intake_read_ip', 'intake_submit_ip', 'intake_submit_ip_day', 'intake_submit_form'));

-- 5. email_messages: avisos de solicitud --------------------------------------------------------
-- Tres tipos nuevos. Los de cotización siguen exigiendo cotización y paquete; los de solicitud exigen la
-- solicitud; el del tope, el formulario. Nunca llevan datos de quien llenó el formulario.
alter table public.email_messages drop constraint email_messages_kind_check;
alter table public.email_messages add constraint email_messages_kind_check
  check (kind in ('quote', 'quote_resend', 'internal_notice', 'payment_1', 'payment_2',
                  'request_assigned', 'request_received', 'intake_cap_reached'));
alter table public.email_messages
  alter column quote_id drop not null,
  alter column package_id drop not null,
  add column intake_request_id uuid,
  add column intake_form_id uuid,
  add foreign key (tenant_id, intake_request_id) references public.intake_requests (tenant_id, id),
  add foreign key (tenant_id, intake_form_id) references public.intake_forms (tenant_id, id),
  add constraint email_messages_target_shape check (
       (kind in ('quote', 'quote_resend', 'internal_notice', 'payment_1', 'payment_2')
        and quote_id is not null and package_id is not null
        and intake_request_id is null and intake_form_id is null)
    or (kind in ('request_assigned', 'request_received')
        and intake_request_id is not null
        and quote_id is null and package_id is null and intake_form_id is null)
    or (kind = 'intake_cap_reached'
        and intake_form_id is not null
        and quote_id is null and package_id is null and intake_request_id is null));
create index email_messages_intake_request on public.email_messages (tenant_id, intake_request_id, created_at)
  where intake_request_id is not null;
create index email_messages_intake_form on public.email_messages (tenant_id, intake_form_id, created_at)
  where intake_form_id is not null;

-- El registro de correos sigue siendo de solo agregar; la única salida es la limpieza por plazo de los
-- avisos de solicitud (para poder borrar una solicitud vencida junto con sus avisos).
create or replace function app.email_messages_guard() returns trigger
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
    if current_setting('app.retention_purge', true) is not distinct from 'on'
       and old.kind in ('request_assigned', 'request_received') then
      return old;
    end if;
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
