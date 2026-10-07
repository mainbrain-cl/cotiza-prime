-- Migración 34 — Correcciones de la revisión de las migraciones 29 a 33 (sprint 4)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261007150000_intake_review_fixes.down.sql
-- Especificación: docs/arquitectura/sprint-4-formulario-publico.md, sección «Correcciones de la revisión de las
-- migraciones».
--
-- Importantes:
--  I1  El consentimiento se puede comprobar después: la solicitud guarda el TEXTO que se aceptó (solo datos de
--      la organización, nunca del visitante) y la base exige que su huella sea la del texto. La versión de la
--      plantilla tiene formato fijo `intake-v<n>`. Las filas anteriores a esta migración no tienen el texto:
--      quedan marcadas `consent_text_unavailable` (no se inventa un texto para ellas).
--  I2  `anonymize_intake_request`: derecho de supresión (Ley 21.719) para Dueño y Administrador, en cualquier
--      estado.
--  I3  `convert_intake_request` revisa que la cotización devuelta sea un borrador sin solicitud de origen.
-- Menores: ver el plan, sección «Correcciones de la revisión de las migraciones» (números 1 a 14).
--
-- Desviaciones, justificadas:
--  * `intake_request_submit` no recibe la huella del texto: la calcula la base a partir del texto (así no
--    pueden venir las dos inconsistentes).
--  * El motivo de `anonymize_intake_request` es de una lista cerrada (`data_subject_request`, `wrong_data`,
--    `other`): un texto libre podría llevar datos personales a la auditoría.
--  * (8) Un servicio del catálogo inactivo se rechaza al agregarlo o cambiarlo; uno que el formulario ya traía
--    con ese mismo servicio no impide guardar otros cambios (si no, desactivar un servicio del catálogo
--    bloquearía todo el formulario).
--  * (10) La auditoría de la limpieza lleva una fila por organización afectada (la tabla de auditoría exige
--    `tenant_id`; no hay una fila «global»).

-- 0. (13) business_date_of depende de now() y de la zona horaria: no es inmutable ---------------------------
create or replace function app.business_date_of(p_at timestamptz) returns date
language sql stable set search_path = '' as $$
  select (p_at at time zone app.business_timezone())::date
$$;

-- 1. I1 · consentimiento comprobable ---------------------------------------------------------------------
alter table public.intake_requests
  add column consent_text text,
  -- Las filas que ya existen no tienen el texto: nacen con `true` y desde ahora el valor por defecto es `false`.
  add column consent_text_unavailable boolean not null default true;
alter table public.intake_requests alter column consent_text_unavailable set default false;

alter table public.intake_requests
  add constraint intake_requests_consent_text_shape check (
    (consent_text is null) = consent_text_unavailable
    and (consent_text is null or (
          char_length(consent_text) between 1 and 3000
          and not app.intake_text_unsafe(consent_text, true)
          and consent_text_sha256 = encode(sha256(convert_to(consent_text, 'UTF8')), 'hex')))),
  add constraint intake_requests_consent_version_format check (
    consent_text_unavailable or consent_template_version ~ '^intake-v[0-9]+$');

grant select (consent_text, consent_text_unavailable) on public.intake_requests to authenticated;

-- 2. Contador: aviso del tope de la ORGANIZACIÓN (menor 5) --------------------------------------------------
alter table public.intake_daily_counters add column org_cap_notified_at timestamptz;

-- 3. Índice de la limpieza de descartadas (menor 10) ---------------------------------------------------------
-- Excepción justificada a «índice con tenant_id»: la limpieza por plazo recorre todas las organizaciones.
create index intake_requests_discarded on public.intake_requests (discarded_at) where status = 'discarded';

-- 4. Guarda de intake_requests: ahora también deja anonimizar a quien ejerce el derecho de supresión (I2) -------
create or replace function app.intake_requests_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c_moving constant text[] := array['status', 'assigned_to', 'assigned_at', 'assigned_by', 'discard_reason',
                                    'discard_note', 'discarded_by', 'discarded_at', 'quote_id', 'converted_by',
                                    'converted_at'];
  c_anonymized constant text[] := array['contact_name_enc', 'contact_email_enc', 'contact_phone_enc', 'company_enc',
                                        'comuna_enc', 'service_address_enc', 'message_enc', 'contact_email_hash',
                                        'consent_ip_enc', 'anonymized_at'];
  v_purge boolean := current_setting('app.retention_purge', true) is not distinct from 'on';
  -- Lo fija solo anonymize_intake_request, dentro de su transacción.
  v_anon  boolean := current_setting('app.intake_anonymize', true) is not distinct from 'on';
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
      if v_new -> v_key is distinct from v_old -> v_key then
        -- Anonimizar, y solo vaciando: (a) la limpieza por plazo, una solicitud convertida con más de 12
        -- meses; (b) el derecho de supresión, en cualquier estado.
        if not (
             (v_purge and old.status = 'converted' and old.anonymized_at is null
              and new.anonymized_at is not null
              and old.created_at <= now() - make_interval(months => app.intake_converted_anonymize_months())
              and (v_key = 'anonymized_at' or v_new -> v_key = 'null'::jsonb))
          or (v_anon and old.anonymized_at is null and new.anonymized_at is not null
              and (v_key = 'anonymized_at' or v_new -> v_key = 'null'::jsonb))) then
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

-- 5. Guarda de email_messages: el borrado por plazo de un aviso de solicitud queda amarrado al vencimiento (menor 9) ---
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
    -- Solo la limpieza por plazo, y solo el aviso de una solicitud que ya venció (la misma regla con que se
    -- borra la solicitud).
    if current_setting('app.retention_purge', true) is not distinct from 'on'
       and old.kind in ('request_assigned', 'request_received')
       and exists (
         select 1 from public.intake_requests r
          where r.tenant_id = old.tenant_id and r.id = old.intake_request_id
            and ((r.status in ('new', 'assigned')
                  and r.created_at <= now() - make_interval(months => app.intake_unconverted_retention_months()))
              or (r.status = 'discarded'
                  and r.discarded_at <= now() - make_interval(days => app.intake_discarded_retention_days())))) then
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

-- 6. I1 · intake_request_submit recibe el texto del consentimiento (cambia la firma) -----------------------------
-- Más: (5) `cap_kind` y aviso único del tope de la organización; (6) la auditoría lleva la correlación.
drop function public.intake_request_submit(text, uuid, uuid, integer, text, text, text, text, text, text, text, text, date, jsonb, text, text, text);

-- Una solicitud nueva, en una sola transacción y con el formulario bloqueado. Orden: (1) el formulario
-- (la organización sale de su fila); (2) la misma clave de envío devuelve la misma solicitud; (3) no
-- publicado; (4) revisión distinta; (5) servicios (se revalidan contra ESTE formulario y el nombre y la
-- unidad se reescriben desde la base); (6) datos obligatorios; (7) topes; (8) se guarda y se cuenta;
-- (9) auditoría.
-- p_items: [{form_item_id, quantity_milli}].
-- p_consent_text: el texto que vio quien aceptó (solo datos de la organización; la base calcula su huella).
-- result: ok | paused | not_found | form_changed | invalid_items | invalid_data | cap_reached
-- (cap_reached trae `cap_kind`: form | org).
create function public.intake_request_submit(
  p_public_id text, p_request_id uuid, p_submit_key uuid, p_form_revision integer,
  p_contact_name_enc text, p_contact_email_enc text, p_contact_phone_enc text, p_company_enc text,
  p_comuna_enc text, p_service_address_enc text, p_message_enc text, p_contact_email_hash text,
  p_desired_date date, p_items jsonb, p_consent_template_version text, p_consent_text text,
  p_consent_ip_enc text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_short_enc_max constant integer := 2000;
  c_message_enc_max constant integer := 12000;
  f          public.intake_forms;
  t          public.tenants;
  r          public.intake_requests;
  v_item     jsonb;
  v_key      text;
  v_form_item public.intake_form_items;
  v_seen     uuid[] := array[]::uuid[];
  v_id       uuid;
  v_qty      bigint;
  v_stored   jsonb := '[]'::jsonb;
  v_today    date := app.business_date_of(now());
  v_form_accepted integer;
  v_org_accepted  integer;
  v_cap_kind text;
  v_first    boolean;
  v_present  record;
  v_sha      text;
  v_headers  json := nullif(current_setting('request.headers', true), '')::json;
  v_corr     uuid;
begin
  -- Forma de los argumentos: un error aquí es del servidor, no del visitante.
  if p_public_id is null or p_request_id is null or p_submit_key is null or p_form_revision is null
     or p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if p_public_id !~ '^[A-Za-z0-9_-]{22}$' then
    return jsonb_build_object('result', 'not_found');
  end if;
  if p_contact_name_enc is null or p_contact_email_enc is null or p_contact_email_hash is null
     or p_consent_template_version is null or p_consent_text is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if p_contact_email_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_hash' using errcode = 'CP422';
  end if;
  if p_consent_template_version !~ '^intake-v[0-9]+$' or char_length(p_consent_template_version) > 40 then
    raise exception 'invalid_consent_version' using errcode = 'CP422';
  end if;
  if char_length(p_consent_text) not between 1 and 3000 or app.intake_text_unsafe(p_consent_text, true) then
    raise exception 'invalid_consent_text' using errcode = 'CP422';
  end if;
  v_sha := encode(sha256(convert_to(p_consent_text, 'UTF8')), 'hex');
  if char_length(p_contact_name_enc) not between 1 and c_short_enc_max
     or char_length(p_contact_email_enc) not between 1 and c_short_enc_max
     or (p_contact_phone_enc is not null and char_length(p_contact_phone_enc) not between 1 and c_short_enc_max)
     or (p_company_enc is not null and char_length(p_company_enc) not between 1 and c_short_enc_max)
     or (p_comuna_enc is not null and char_length(p_comuna_enc) not between 1 and c_short_enc_max)
     or (p_service_address_enc is not null and char_length(p_service_address_enc) not between 1 and c_short_enc_max)
     or (p_message_enc is not null and char_length(p_message_enc) not between 1 and c_message_enc_max)
     or (p_consent_ip_enc is not null and char_length(p_consent_ip_enc) not between 1 and c_short_enc_max) then
    raise exception 'invalid_encrypted_value' using errcode = 'CP422';
  end if;
  if jsonb_array_length(p_items) not between 1 and app.intake_request_items_max() then
    raise exception 'invalid_items_shape' using errcode = 'CP422';
  end if;
  for v_item in select e from jsonb_array_elements(p_items) e loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'invalid_items_shape' using errcode = 'CP422';
    end if;
    for v_key in select k from jsonb_object_keys(v_item) k loop
      if v_key not in ('form_item_id', 'quantity_milli') then
        raise exception 'invalid_items_shape' using errcode = 'CP422';
      end if;
    end loop;
    if jsonb_typeof(v_item -> 'form_item_id') is distinct from 'string' or not app.is_uuid_text(v_item ->> 'form_item_id')
       or (coalesce(jsonb_typeof(v_item -> 'quantity_milli'), 'null') <> 'null'
           and not app.calc_jsonb_int_in_range(v_item -> 'quantity_milli', app.intake_qty_min_milli(), app.intake_qty_max_milli())) then
      raise exception 'invalid_items_shape' using errcode = 'CP422';
    end if;
  end loop;

  -- (1) El formulario, bloqueado. La organización sale de esta fila, nunca de un argumento.
  select * into f from public.intake_forms where public_id = p_public_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  select * into t from public.tenants where tenant_id = f.tenant_id;
  if t.status <> 'active' or t.kind <> 'organization' then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- (2) El mismo envío repetido (reintento por mala conexión): la misma solicitud, sin hacer nada más.
  select * into r from public.intake_requests
   where tenant_id = f.tenant_id and form_id = f.id and submit_key = p_submit_key;
  if found then
    return jsonb_build_object('result', 'ok', 'replayed', true, 'request_id', r.id,
                              'tenant_id', f.tenant_id, 'form_id', f.id, 'form_name', f.name);
  end if;

  -- (3) Solo un formulario publicado recibe solicitudes.
  if f.status = 'paused' then
    perform app.intake_count(f.tenant_id, f.id, 'paused');
    return jsonb_build_object('result', 'paused', 'tenant_id', f.tenant_id, 'form_id', f.id);
  end if;
  if f.status <> 'published' then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- (4) El formulario que vio la persona ya no es el vigente (el administrador lo editó).
  if p_form_revision <> f.revision then
    return jsonb_build_object('result', 'form_changed', 'revision', f.revision,
                              'tenant_id', f.tenant_id, 'form_id', f.id);
  end if;

  -- (5) Servicios: cada uno tiene que ser un servicio ACTIVO de ESTE formulario; el nombre y la unidad
  -- se reescriben desde la base (lo que mandó el navegador no se guarda), y la cantidad respeta el modo.
  for v_item in select e from jsonb_array_elements(p_items) e loop
    v_id := (v_item ->> 'form_item_id')::uuid;
    if v_id = any (v_seen) then
      perform app.intake_count(f.tenant_id, f.id, 'invalid');
      return jsonb_build_object('result', 'invalid_items', 'tenant_id', f.tenant_id, 'form_id', f.id);
    end if;
    v_seen := v_seen || v_id;
    select * into v_form_item from public.intake_form_items i
     where i.tenant_id = f.tenant_id and i.form_id = f.id and i.id = v_id and i.is_active;
    if not found then
      perform app.intake_count(f.tenant_id, f.id, 'invalid');
      return jsonb_build_object('result', 'invalid_items', 'tenant_id', f.tenant_id, 'form_id', f.id);
    end if;
    v_qty := case when coalesce(jsonb_typeof(v_item -> 'quantity_milli'), 'null') <> 'null'
                  then (v_item ->> 'quantity_milli')::bigint end;
    if (v_form_item.quantity_mode = 'none' and v_qty is not null)
       or (v_form_item.quantity_mode = 'required' and v_qty is null)
       or (v_qty is not null and v_form_item.min_qty_milli is not null and v_qty < v_form_item.min_qty_milli)
       or (v_qty is not null and v_form_item.max_qty_milli is not null and v_qty > v_form_item.max_qty_milli) then
      perform app.intake_count(f.tenant_id, f.id, 'invalid');
      return jsonb_build_object('result', 'invalid_items', 'tenant_id', f.tenant_id, 'form_id', f.id);
    end if;
    v_stored := v_stored || jsonb_build_array(jsonb_build_object(
      'form_item_id', v_form_item.id, 'catalog_item_id', v_form_item.catalog_item_id,
      'name', v_form_item.public_name, 'unit', v_form_item.unit, 'quantity_milli', v_qty));
  end loop;

  -- (6) Datos: lo que el formulario no pide no se guarda y lo que pide como obligatorio tiene que venir.
  for v_present in
    select * from (values
      ('phone', p_contact_phone_enc is not null),
      ('company', p_company_enc is not null),
      ('comuna', p_comuna_enc is not null),
      ('serviceAddress', p_service_address_enc is not null),
      ('message', p_message_enc is not null),
      ('desiredDate', p_desired_date is not null)) as v(k, present)
  loop
    if (f.fields ->> v_present.k = 'off' and v_present.present)
       or (f.fields ->> v_present.k = 'required' and not v_present.present) then
      perform app.intake_count(f.tenant_id, f.id, 'invalid');
      return jsonb_build_object('result', 'invalid_data', 'tenant_id', f.tenant_id, 'form_id', f.id);
    end if;
  end loop;
  if p_desired_date is not null
     and (p_desired_date < v_today or p_desired_date > (v_today + interval '1 year')::date) then
    perform app.intake_count(f.tenant_id, f.id, 'invalid');
    return jsonb_build_object('result', 'invalid_data', 'tenant_id', f.tenant_id, 'form_id', f.id);
  end if;

  -- (7) Topes del día (en hora de Chile): el del formulario y el de toda la organización. El candado de
  -- la organización hace que dos formularios suyos no se pasen del tope a la vez.
  perform pg_advisory_xact_lock(hashtextextended('intake_org_cap:' || f.tenant_id::text, 0));
  select coalesce(sum(c.accepted), 0) into v_org_accepted
    from public.intake_daily_counters c where c.tenant_id = f.tenant_id and c.day = v_today;
  select coalesce(c.accepted, 0) into v_form_accepted
    from public.intake_daily_counters c where c.tenant_id = f.tenant_id and c.form_id = f.id and c.day = v_today;
  v_form_accepted := coalesce(v_form_accepted, 0);
  if v_form_accepted >= f.daily_cap or v_org_accepted >= app.intake_org_daily_cap() then
    -- Cuál tope: si se cumplen los dos, manda el del formulario.
    v_cap_kind := case when v_form_accepted >= f.daily_cap then 'form' else 'org' end;
    perform app.intake_count(f.tenant_id, f.id, 'cap');
    -- El aviso al equipo sale solo la primera vez del día: una vez por formulario si es su tope, y una vez
    -- por organización si es el de la organización (el candado de arriba lo serializa).
    if v_cap_kind = 'form' then
      update public.intake_daily_counters set cap_notified_at = now()
       where tenant_id = f.tenant_id and form_id = f.id and day = v_today and cap_notified_at is null
      returning true into v_first;
    elsif not exists (select 1 from public.intake_daily_counters c
                       where c.tenant_id = f.tenant_id and c.day = v_today and c.org_cap_notified_at is not null) then
      update public.intake_daily_counters set org_cap_notified_at = now()
       where tenant_id = f.tenant_id and form_id = f.id and day = v_today
      returning true into v_first;
    end if;
    return jsonb_build_object('result', 'cap_reached', 'cap_kind', v_cap_kind,
                              'notify_cap', coalesce(v_first, false),
                              'tenant_id', f.tenant_id, 'form_id', f.id, 'form_name', f.name);
  end if;

  -- (8) Se guarda y se cuenta.
  insert into public.intake_requests
    (id, tenant_id, form_id, contact_name_enc, contact_email_enc, contact_phone_enc, company_enc, comuna_enc,
     service_address_enc, message_enc, contact_email_hash, desired_date, items, form_revision, submit_key,
     consent_template_version, consent_text, consent_text_sha256, consent_ip_enc)
  values
    (p_request_id, f.tenant_id, f.id, p_contact_name_enc, p_contact_email_enc, p_contact_phone_enc, p_company_enc,
     p_comuna_enc, p_service_address_enc, p_message_enc, p_contact_email_hash, p_desired_date, v_stored,
     f.revision, p_submit_key, p_consent_template_version, p_consent_text, v_sha, p_consent_ip_enc);
  perform app.intake_count(f.tenant_id, f.id, 'accepted');

  -- (9) Auditoría: sin la IP, el nombre, el correo ni el mensaje. La correlación viene de la cabecera que
  -- reenvía la aplicación (como en write_audit): es orientativa.
  begin v_corr := nullif(v_headers ->> 'x-cp-request-id', '')::uuid;
  exception when others then v_corr := null; end;
  insert into public.audit_log
    (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, result, correlation_id, details)
  values (f.tenant_id, 'public', null, 'intake_request.received', 'intake_request', p_request_id, 'success', v_corr,
          jsonb_build_object('form_id', f.id, 'form_revision', f.revision));

  return jsonb_build_object('result', 'ok', 'replayed', false, 'request_id', p_request_id,
                            'tenant_id', f.tenant_id, 'form_id', f.id, 'form_name', f.name);
end $$;
revoke all on function public.intake_request_submit(text, uuid, uuid, integer, text, text, text, text, text, text, text, text, date, jsonb, text, text, text)
  from public, anon, authenticated;
grant execute on function public.intake_request_submit(text, uuid, uuid, integer, text, text, text, text, text, text, text, text, date, jsonb, text, text, text)
  to service_role;

-- 7. (1) intake_record_block: solo captcha, tasa e inválido, y solo de formularios publicados o en pausa ------------
-- El tope y la pausa ya se cuentan dentro del envío; un borrador o un archivado no recibe nada.
create or replace function public.intake_record_block(p_public_id text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f public.intake_forms;
begin
  if p_reason is null or p_reason not in ('captcha', 'rate', 'invalid') then
    raise exception 'invalid_reason' using errcode = 'CP422';
  end if;
  if p_public_id is null or p_public_id !~ '^[A-Za-z0-9_-]{22}$' then
    return jsonb_build_object('recorded', false);
  end if;
  select * into f from public.intake_forms where public_id = p_public_id;
  if not found or f.status not in ('published', 'paused') then
    return jsonb_build_object('recorded', false);
  end if;
  perform app.intake_count(f.tenant_id, f.id, p_reason);
  return jsonb_build_object('recorded', true);
end $$;

-- 8. Avisos al equipo (menores 2, 3 y 4) -------------------------------------------------------------------
-- La regla de destinatarios en un solo lugar. Si la organización ya no está activa, no hay destinatarios.
--   request_assigned   → la persona asignada si sigue como miembro activo (con correo); si no, Dueño y Administradores.
--   request_received e intake_cap_reached → Dueño y Administradores activos.
create function app.intake_notice_audience(p_tenant uuid, p_kind text, p_assigned_to uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.tenants t
                  where t.tenant_id = p_tenant and t.status = 'active' and t.kind = 'organization') then
    return jsonb_build_object('audience', 'managers', 'recipients', '[]'::jsonb);
  end if;
  if p_kind = 'request_assigned' and p_assigned_to is not null
     and exists (select 1 from public.members m join auth.users u on u.id = m.user_id
                  where m.tenant_id = p_tenant and m.user_id = p_assigned_to and m.status = 'active'
                    and u.email is not null) then
    return jsonb_build_object('audience', 'assignee', 'recipients', (
      select jsonb_build_array(jsonb_build_object('user_id', u.id, 'email', u.email::text))
        from auth.users u where u.id = p_assigned_to));
  end if;
  return jsonb_build_object('audience', 'managers', 'recipients', app.intake_managers(p_tenant));
end $$;
revoke all on function app.intake_notice_audience(uuid, text, uuid) from public, anon, authenticated;

create or replace function public.intake_notice_recipients(p_request_id uuid, p_kind text, p_form_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r          public.intake_requests;
  f          public.intake_forms;
  t          public.tenants;
  v_tenant   uuid;
  v_aud      jsonb;
  v_recipients jsonb;
  v_notified integer;
  v_limited  boolean := false;
begin
  if p_kind is null or p_kind not in ('request_assigned', 'request_received', 'intake_cap_reached') then
    raise exception 'invalid_kind' using errcode = 'CP422';
  end if;
  if p_kind = 'intake_cap_reached' then
    if p_form_id is null or p_request_id is not null then
      raise exception 'invalid_arguments' using errcode = 'CP422';
    end if;
    select * into f from public.intake_forms where id = p_form_id;
    if not found then
      raise exception 'form_not_found' using errcode = 'CP404';
    end if;
    v_tenant := f.tenant_id;
    v_aud := app.intake_notice_audience(v_tenant, p_kind, null);
  else
    if p_request_id is null or p_form_id is not null then
      raise exception 'invalid_arguments' using errcode = 'CP422';
    end if;
    select * into r from public.intake_requests where id = p_request_id;
    if not found then
      raise exception 'request_not_found' using errcode = 'CP404';
    end if;
    v_tenant := r.tenant_id;
    select * into f from public.intake_forms where tenant_id = r.tenant_id and id = r.form_id;
    v_aud := app.intake_notice_audience(v_tenant, p_kind, r.assigned_to);
    if p_kind = 'request_received' then
      -- Tope de avisos del día: solo cuentan las solicitudes distintas ya avisadas (esta, si ya lo estaba, no suma).
      -- El candado es el mismo que usa el registro; aquí solo ordena la lectura.
      perform pg_advisory_xact_lock(hashtextextended('intake_notice:request_received:' || v_tenant::text, 0));
      select count(distinct e.intake_request_id) into v_notified
        from public.email_messages e
       where e.tenant_id = v_tenant and e.kind = 'request_received'
         and e.intake_request_id <> r.id
         and e.created_at >= (app.business_date_of(now())::timestamp at time zone app.business_timezone());
      if v_notified >= app.intake_request_notices_per_day() then
        v_limited := true;
        v_aud := jsonb_set(v_aud, '{recipients}', '[]'::jsonb);
      end if;
    end if;
  end if;
  v_recipients := v_aud -> 'recipients';
  select * into t from public.tenants where tenant_id = v_tenant;
  return jsonb_build_object(
    'kind', p_kind, 'audience', v_aud ->> 'audience', 'recipients', v_recipients, 'limited', v_limited,
    'tenant_id', v_tenant, 'tenant_name', t.name, 'form_id', f.id, 'form_name', f.name,
    'request_id', p_request_id);
end $$;

create or replace function public.intake_notice_register(
  p_email_id uuid, p_request_id uuid, p_kind text, p_to_user_id uuid, p_to_email_enc text, p_to_email_hash text,
  p_form_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r        public.intake_requests;
  f        public.intake_forms;
  v_tenant uuid;
  v_notified integer;
  v_rows   integer;
  v_assigned uuid;
begin
  if p_email_id is null or p_kind is null or p_to_user_id is null or p_to_email_enc is null
     or char_length(p_to_email_enc) not between 1 and 2000
     or p_to_email_hash is null or p_to_email_hash !~ '^[0-9a-f]{64}$'
     or p_kind not in ('request_assigned', 'request_received', 'intake_cap_reached') then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if p_kind = 'intake_cap_reached' then
    if p_form_id is null or p_request_id is not null then
      raise exception 'invalid_arguments' using errcode = 'CP422';
    end if;
    select * into f from public.intake_forms where id = p_form_id;
    if not found then
      raise exception 'form_not_found' using errcode = 'CP404';
    end if;
    v_tenant := f.tenant_id;
  else
    if p_request_id is null or p_form_id is not null then
      raise exception 'invalid_arguments' using errcode = 'CP422';
    end if;
    select * into r from public.intake_requests where id = p_request_id;
    if not found then
      raise exception 'request_not_found' using errcode = 'CP404';
    end if;
    v_tenant := r.tenant_id;
    v_assigned := r.assigned_to;
  end if;
  -- (4) La organización tiene que seguir activa.
  if not exists (select 1 from public.tenants t
                  where t.tenant_id = v_tenant and t.status = 'active' and t.kind = 'organization') then
    return jsonb_build_object('registered', false, 'reason', 'tenant_inactive');
  end if;
  -- (2) El destinatario es uno de los que `intake_notice_recipients` entrega para este aviso.
  if not exists (
       select 1 from jsonb_array_elements(
                app.intake_notice_audience(v_tenant, p_kind, v_assigned) -> 'recipients') e
        where (e ->> 'user_id')::uuid = p_to_user_id) then
    raise exception 'recipient_not_allowed' using errcode = '42501';
  end if;
  if p_kind = 'request_received' then
    -- (3) El tope de 20 avisos al día se cuenta con un candado por organización y tipo: dos registros a la vez
    -- no se lo saltan.
    perform pg_advisory_xact_lock(hashtextextended('intake_notice:request_received:' || v_tenant::text, 0));
    select count(distinct e.intake_request_id) into v_notified
      from public.email_messages e
     where e.tenant_id = v_tenant and e.kind = 'request_received' and e.intake_request_id <> p_request_id
       and e.created_at >= (app.business_date_of(now())::timestamp at time zone app.business_timezone());
    if v_notified >= app.intake_request_notices_per_day() then
      return jsonb_build_object('registered', false, 'reason', 'daily_limit');
    end if;
  end if;
  insert into public.email_messages
    (id, tenant_id, intake_request_id, intake_form_id, kind, to_email_enc, to_email_hash, provider, status)
  values
    (p_email_id, v_tenant, p_request_id, p_form_id, p_kind, p_to_email_enc, p_to_email_hash, 'pending', 'pending')
  on conflict (id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    -- (2) Ese identificador ya existe: solo es un reintento si es el mismo aviso. Si es de otra fila, no se registra.
    if not exists (select 1 from public.email_messages e
                    where e.id = p_email_id and e.tenant_id = v_tenant and e.kind = p_kind
                      and e.intake_request_id is not distinct from p_request_id
                      and e.intake_form_id is not distinct from p_form_id
                      and e.to_email_hash = p_to_email_hash) then
      return jsonb_build_object('registered', false, 'reason', 'id_in_use');
    end if;
  end if;
  return jsonb_build_object('registered', true);
end $$;

-- 9. (7) y (8) save_intake_form -------------------------------------------------------------------------------
-- Foto de los servicios de un formulario: completa (para la auditoría) o la que ve el público (para la revisión).
create function app.intake_items_snapshot(p_tenant uuid, p_form uuid, p_public boolean) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(
    case when p_public
      then jsonb_build_object('id', i.id, 'name', i.public_name, 'description', i.public_description,
                              'unit', i.unit, 'quantity_mode', i.quantity_mode,
                              'min', i.min_qty_milli, 'max', i.max_qty_milli)
      else jsonb_build_object('id', i.id, 'position', i.position, 'kind', i.kind,
                              'catalog_item_id', i.catalog_item_id, 'name', i.public_name,
                              'description', i.public_description, 'unit', i.unit,
                              'quantity_mode', i.quantity_mode, 'min', i.min_qty_milli, 'max', i.max_qty_milli,
                              'is_active', i.is_active)
    end order by i.position, i.id), '[]'::jsonb)
    from public.intake_form_items i
   where i.tenant_id = p_tenant and i.form_id = p_form and (not p_public or i.is_active)
$$;
revoke all on function app.intake_items_snapshot(uuid, uuid, boolean) from public, anon, authenticated;

create or replace function public.save_intake_form(
  p_form_id uuid, p_expected_revision integer, p_form jsonb, p_items jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_form_keys constant text[] :=
    array['name', 'title', 'intro', 'success_message', 'fields', 'embed_origins', 'daily_cap', 'privacy_policy_url'];
  c_item_keys constant text[] :=
    array['id', 'kind', 'catalog_item_id', 'public_name', 'public_description', 'unit', 'quantity_mode',
          'min_qty_milli', 'max_qty_milli', 'is_active'];
  c_units constant text[] := array['service', 'hour', 'km', 'm2', 'day', 'unit'];
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  f        public.intake_forms;
  v_form   jsonb := coalesce(p_form, '{}'::jsonb);
  v_key    text;
  v_name   text;
  v_title  text;
  v_intro  text;
  v_success text;
  v_fields jsonb;
  v_origins text[];
  v_old_origins text[];
  v_cap    integer;
  v_url    text;
  v_changed text[] := array[]::text[];
  v_ids    uuid[] := array[]::uuid[];
  v_item   jsonb;
  v_pos    integer;
  v_id     uuid;
  v_kind   text;
  v_cat    uuid;
  v_pname  text;
  v_pdesc  text;
  v_unit   text;
  v_qmode  text;
  v_min    bigint;
  v_max    bigint;
  v_active boolean;
  v_active_items integer;
  v_items_changed boolean := false;
  v_visible_changed boolean := false;
  v_full_before jsonb;
  v_pub_before  jsonb;
  v_cat_active  boolean;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_form_id is null or p_expected_revision is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if jsonb_typeof(v_form) <> 'object' or (p_items is not null and jsonb_typeof(p_items) <> 'array') then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;

  select * into f from public.intake_forms where tenant_id = v_tenant and id = p_form_id for update;
  if not found then
    raise exception 'form_not_found' using errcode = 'CP404';
  end if;
  if f.revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = 'CP409';
  end if;
  if f.status = 'archived' then
    raise exception 'archived' using errcode = 'CP423';
  end if;

  -- (1) Datos del formulario. Claves desconocidas fuera; cada valor con su tipo.
  for v_key in select k from jsonb_object_keys(v_form) k loop
    if v_key <> all (c_form_keys) then
      raise exception 'unknown_form_key' using errcode = 'CP422';
    end if;
  end loop;

  v_name := f.name; v_title := f.title; v_intro := f.intro; v_success := f.success_message;
  v_old_origins := f.embed_origins;
  v_fields := f.fields; v_origins := f.embed_origins; v_cap := f.daily_cap; v_url := f.privacy_policy_url;

  if v_form ? 'name' then
    if jsonb_typeof(v_form -> 'name') <> 'string' then raise exception 'invalid_name' using errcode = 'CP422'; end if;
    v_name := btrim(v_form ->> 'name');
    if char_length(v_name) not between 1 and 120 or app.intake_text_unsafe(v_name) then
      raise exception 'invalid_name' using errcode = 'CP422';
    end if;
  end if;
  if v_form ? 'title' then
    if jsonb_typeof(v_form -> 'title') <> 'string' then raise exception 'invalid_title' using errcode = 'CP422'; end if;
    v_title := btrim(v_form ->> 'title');
    if char_length(v_title) not between 1 and 120 or app.intake_text_unsafe(v_title) then
      raise exception 'invalid_title' using errcode = 'CP422';
    end if;
  end if;
  if v_form ? 'intro' then
    if jsonb_typeof(v_form -> 'intro') <> 'string' then raise exception 'invalid_intro' using errcode = 'CP422'; end if;
    v_intro := btrim(replace(v_form ->> 'intro', E'\r', ''));
    if char_length(v_intro) > 1000 or app.intake_text_unsafe(v_intro, true) then
      raise exception 'invalid_intro' using errcode = 'CP422';
    end if;
  end if;
  if v_form ? 'success_message' then
    if jsonb_typeof(v_form -> 'success_message') <> 'string' then
      raise exception 'invalid_success_message' using errcode = 'CP422';
    end if;
    v_success := btrim(replace(v_form ->> 'success_message', E'\r', ''));
    if char_length(v_success) > 500 or app.intake_text_unsafe(v_success, true) then
      raise exception 'invalid_success_message' using errcode = 'CP422';
    end if;
  end if;
  if v_form ? 'fields' then
    if not app.intake_fields_valid(v_form -> 'fields') then
      raise exception 'invalid_fields' using errcode = 'CP422';
    end if;
    v_fields := v_form -> 'fields';
  end if;
  if v_form ? 'embed_origins' then
    if jsonb_typeof(v_form -> 'embed_origins') <> 'array'
       or exists (select 1 from jsonb_array_elements(v_form -> 'embed_origins') e where jsonb_typeof(e) <> 'string') then
      raise exception 'invalid_embed_origins' using errcode = 'CP422';
    end if;
    select coalesce(array_agg(distinct e #>> '{}' order by e #>> '{}'), array[]::text[])
      into v_origins from jsonb_array_elements(v_form -> 'embed_origins') e;
    if not app.embed_origins_valid(v_origins) then
      raise exception 'invalid_embed_origins' using errcode = 'CP422';
    end if;
  end if;
  if v_form ? 'daily_cap' then
    if not app.calc_jsonb_int_in_range(v_form -> 'daily_cap', 1, app.intake_max_daily_cap()) then
      raise exception 'invalid_daily_cap' using errcode = 'CP422';
    end if;
    v_cap := (v_form ->> 'daily_cap')::integer;
  end if;
  if v_form ? 'privacy_policy_url' then
    if jsonb_typeof(v_form -> 'privacy_policy_url') = 'null' then
      v_url := null;
    elsif jsonb_typeof(v_form -> 'privacy_policy_url') = 'string' then
      v_url := nullif(btrim(v_form ->> 'privacy_policy_url'), '');
      if not app.intake_policy_url_valid(v_url) then
        raise exception 'invalid_privacy_policy_url' using errcode = 'CP422';
      end if;
    else
      raise exception 'invalid_privacy_policy_url' using errcode = 'CP422';
    end if;
  end if;

  if v_name is distinct from f.name then v_changed := array_append(v_changed, 'name'); end if;
  if v_title is distinct from f.title then v_changed := array_append(v_changed, 'title'); end if;
  if v_intro is distinct from f.intro then v_changed := array_append(v_changed, 'intro'); end if;
  if v_success is distinct from f.success_message then v_changed := array_append(v_changed, 'success_message'); end if;
  if v_fields is distinct from f.fields then v_changed := array_append(v_changed, 'fields'); end if;
  if v_origins is distinct from f.embed_origins then v_changed := array_append(v_changed, 'embed_origins'); end if;
  if v_cap is distinct from f.daily_cap then v_changed := array_append(v_changed, 'daily_cap'); end if;
  if v_url is distinct from f.privacy_policy_url then v_changed := array_append(v_changed, 'privacy_policy_url'); end if;

  -- (7) Solo lo que ve el público sube la revisión: título, introducción, mensaje de éxito, campos, política de
  -- privacidad y servicios. El nombre interno, el tope diario y los sitios autorizados no.
  v_visible_changed := 'title' = any (v_changed) or 'intro' = any (v_changed) or 'success_message' = any (v_changed)
                    or 'fields' = any (v_changed) or 'privacy_policy_url' = any (v_changed);

  -- (2) Servicios: se valida toda la lista antes de tocar nada.
  if p_items is not null then
    if jsonb_array_length(p_items) > app.intake_max_items_per_form() then
      raise exception 'too_many_items' using errcode = 'CP422';
    end if;
    for v_item in select e from jsonb_array_elements(p_items) e loop
      if jsonb_typeof(v_item) <> 'object' then
        raise exception 'invalid_item' using errcode = 'CP422';
      end if;
      for v_key in select k from jsonb_object_keys(v_item) k loop
        if v_key <> all (c_item_keys) then
          raise exception 'unknown_item_key' using errcode = 'CP422';
        end if;
      end loop;
      if jsonb_typeof(v_item -> 'id') is distinct from 'string' or not app.is_uuid_text(v_item ->> 'id') then
        raise exception 'invalid_item_id' using errcode = 'CP422';
      end if;
      v_id := (v_item ->> 'id')::uuid;
      if v_id = any (v_ids) then
        raise exception 'duplicate_item_id' using errcode = 'CP422';
      end if;
      v_ids := v_ids || v_id;
      -- Un identificador que ya es de otro formulario u otra organización no se reutiliza.
      if exists (select 1 from public.intake_form_items i
                  where i.id = v_id and (i.tenant_id <> v_tenant or i.form_id <> p_form_id)) then
        raise exception 'item_id_taken' using errcode = 'CP422';
      end if;
      v_kind := v_item ->> 'kind';
      if jsonb_typeof(v_item -> 'kind') is distinct from 'string' or v_kind not in ('catalog', 'free') then
        raise exception 'invalid_item_kind' using errcode = 'CP422';
      end if;
      if v_kind = 'catalog' then
        if jsonb_typeof(v_item -> 'catalog_item_id') is distinct from 'string'
           or not app.is_uuid_text(v_item ->> 'catalog_item_id') then
          raise exception 'invalid_catalog_item' using errcode = 'CP422';
        end if;
        select c.is_active into v_cat_active from public.catalog_items c
         where c.tenant_id = v_tenant and c.id = (v_item ->> 'catalog_item_id')::uuid;
        if not found then
          raise exception 'catalog_item_not_found' using errcode = 'CP404';
        end if;
        -- (8) Un servicio inactivo del catálogo no se ofrece; el que el formulario ya traía con ese mismo
        -- servicio no impide guardar otros cambios.
        if not v_cat_active
           and coalesce(case when jsonb_typeof(v_item -> 'is_active') = 'boolean'
                             then (v_item ->> 'is_active')::boolean end, true)
           and not exists (select 1 from public.intake_form_items i
                            where i.tenant_id = v_tenant and i.form_id = p_form_id
                              and i.id = (v_item ->> 'id')::uuid
                              and i.catalog_item_id = (v_item ->> 'catalog_item_id')::uuid) then
          raise exception 'catalog_item_inactive' using errcode = 'CP422';
        end if;
      elsif coalesce(jsonb_typeof(v_item -> 'catalog_item_id'), 'null') <> 'null' then
        raise exception 'invalid_catalog_item' using errcode = 'CP422';
      end if;
      if jsonb_typeof(v_item -> 'public_name') is distinct from 'string'
         or char_length(btrim(v_item ->> 'public_name')) not between 1 and 150
         or app.intake_text_unsafe(btrim(v_item ->> 'public_name')) then
        raise exception 'invalid_item_name' using errcode = 'CP422';
      end if;
      if coalesce(jsonb_typeof(v_item -> 'public_description'), 'null') not in ('null', 'string')
         or (jsonb_typeof(v_item -> 'public_description') = 'string'
             and (char_length(btrim(v_item ->> 'public_description')) > 500
                  or app.intake_text_unsafe(btrim(v_item ->> 'public_description'), true))) then
        raise exception 'invalid_item_description' using errcode = 'CP422';
      end if;
      if jsonb_typeof(v_item -> 'unit') is distinct from 'string' or (v_item ->> 'unit') <> all (c_units) then
        raise exception 'invalid_item_unit' using errcode = 'CP422';
      end if;
      if v_item ? 'quantity_mode'
         and (jsonb_typeof(v_item -> 'quantity_mode') is distinct from 'string'
              or (v_item ->> 'quantity_mode') not in ('none', 'optional', 'required')) then
        raise exception 'invalid_quantity_mode' using errcode = 'CP422';
      end if;
      foreach v_key in array array['min_qty_milli', 'max_qty_milli'] loop
        if coalesce(jsonb_typeof(v_item -> v_key), 'null') <> 'null'
           and not app.calc_jsonb_int_in_range(v_item -> v_key, app.intake_qty_min_milli(), app.intake_qty_max_milli()) then
          raise exception 'invalid_quantity_limit' using errcode = 'CP422';
        end if;
      end loop;
      if coalesce(jsonb_typeof(v_item -> 'min_qty_milli'), 'null') <> 'null'
         and coalesce(jsonb_typeof(v_item -> 'max_qty_milli'), 'null') <> 'null'
         and (v_item ->> 'min_qty_milli')::bigint > (v_item ->> 'max_qty_milli')::bigint then
        raise exception 'invalid_quantity_limit' using errcode = 'CP422';
      end if;
      if v_item ? 'is_active' and jsonb_typeof(v_item -> 'is_active') <> 'boolean' then
        raise exception 'invalid_item_active' using errcode = 'CP422';
      end if;
    end loop;

    -- (3) Se aplican: los que no vienen se quitan; los demás se agregan o se actualizan por su id.
    v_full_before := app.intake_items_snapshot(v_tenant, p_form_id, false);
    v_pub_before  := app.intake_items_snapshot(v_tenant, p_form_id, true);
    delete from public.intake_form_items
     where tenant_id = v_tenant and form_id = p_form_id and id <> all (v_ids);
    v_pos := 0;
    for v_item in select e from jsonb_array_elements(p_items) e loop
      v_kind := v_item ->> 'kind';
      v_cat := case when v_kind = 'catalog' then (v_item ->> 'catalog_item_id')::uuid end;
      v_pname := btrim(v_item ->> 'public_name');
      v_pdesc := case when jsonb_typeof(v_item -> 'public_description') = 'string'
                      then nullif(btrim(replace(v_item ->> 'public_description', E'\r', '')), '') end;
      v_unit := v_item ->> 'unit';
      v_qmode := coalesce(v_item ->> 'quantity_mode', 'optional');
      v_min := case when coalesce(jsonb_typeof(v_item -> 'min_qty_milli'), 'null') <> 'null'
                    then (v_item ->> 'min_qty_milli')::bigint end;
      v_max := case when coalesce(jsonb_typeof(v_item -> 'max_qty_milli'), 'null') <> 'null'
                    then (v_item ->> 'max_qty_milli')::bigint end;
      v_active := coalesce((v_item ->> 'is_active')::boolean, true);
      insert into public.intake_form_items as i
        (id, tenant_id, form_id, position, kind, catalog_item_id, public_name, public_description, unit,
         quantity_mode, min_qty_milli, max_qty_milli, is_active)
      values
        ((v_item ->> 'id')::uuid, v_tenant, p_form_id, v_pos, v_kind, v_cat, v_pname, v_pdesc, v_unit,
         v_qmode, v_min, v_max, v_active)
      on conflict (id) do update set
        position = excluded.position, kind = excluded.kind, catalog_item_id = excluded.catalog_item_id,
        public_name = excluded.public_name, public_description = excluded.public_description,
        unit = excluded.unit, quantity_mode = excluded.quantity_mode, min_qty_milli = excluded.min_qty_milli,
        max_qty_milli = excluded.max_qty_milli, is_active = excluded.is_active
       where i.tenant_id = excluded.tenant_id and i.form_id = excluded.form_id
         and (i.position, i.kind, i.catalog_item_id, i.public_name, i.public_description, i.unit,
              i.quantity_mode, i.min_qty_milli, i.max_qty_milli, i.is_active)
             is distinct from
             (excluded.position, excluded.kind, excluded.catalog_item_id, excluded.public_name,
              excluded.public_description, excluded.unit, excluded.quantity_mode, excluded.min_qty_milli,
              excluded.max_qty_milli, excluded.is_active);
      v_pos := v_pos + 1;
    end loop;
    v_items_changed := v_full_before is distinct from app.intake_items_snapshot(v_tenant, p_form_id, false);
    v_visible_changed := v_visible_changed
      or v_pub_before is distinct from app.intake_items_snapshot(v_tenant, p_form_id, true);
  end if;

  -- (4) Un formulario publicado nunca se queda sin nada que pedir.
  select count(*) into v_active_items from public.intake_form_items
   where tenant_id = v_tenant and form_id = p_form_id and is_active;
  if f.status in ('published', 'paused') and v_active_items < 1 then
    raise exception 'needs_item' using errcode = 'CP422';
  end if;

  update public.intake_forms
     set name = v_name, title = v_title, intro = v_intro, success_message = v_success, fields = v_fields,
         embed_origins = v_origins, daily_cap = v_cap, privacy_policy_url = v_url,
         revision = case when v_visible_changed then f.revision + 1 else f.revision end
   where tenant_id = v_tenant and id = p_form_id
  returning * into f;

  -- (5) Auditoría: qué se tocó (nunca el contenido), y la lista de sitios con su valor anterior y nuevo.
  if v_items_changed then
    v_changed := array_append(v_changed, 'items');
  end if;
  perform app.write_audit(v_tenant, 'user', v_uid, 'intake_form.updated', 'intake_form', f.id, 'success',
    jsonb_build_object('changed', to_jsonb(v_changed), 'revision', f.revision));
  if 'embed_origins' = any (v_changed) then
    perform app.write_audit(v_tenant, 'user', v_uid, 'intake_form.embed_origins_changed', 'intake_form', f.id,
      'success', jsonb_build_object('old', to_jsonb(v_old_origins), 'new', to_jsonb(f.embed_origins)));
  end if;
  return jsonb_build_object('id', f.id, 'public_id', f.public_id, 'revision', f.revision, 'status', f.status);
end $$;


-- 10. I3 · convert_intake_request revisa la cotización que devuelve create_quote -----------------------------------
create or replace function public.convert_intake_request(p_request_id uuid, p_customer_id uuid, p_creation_key uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  r        public.intake_requests;
  v_quote  uuid;
  v_number text;
  v_qstatus text;
  v_qsource uuid;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin', 'sales') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_request_id is null or p_customer_id is null or p_creation_key is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into r from public.intake_requests where tenant_id = v_tenant and id = p_request_id for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'CP404';
  end if;
  -- El Comercial solo convierte las suyas o las que no tienen responsable.
  if app.has_role('sales') and r.assigned_to is not null and r.assigned_to <> v_uid then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Ya convertida (otro clic, otra pestaña): la misma cotización, sin gastar otro número.
  if r.status = 'converted' then
    select q.number_display into v_number from public.quotes q where q.tenant_id = v_tenant and q.id = r.quote_id;
    return jsonb_build_object('quote_id', r.quote_id, 'number_display', v_number, 'converted', false);
  end if;
  if r.status = 'discarded' then
    raise exception 'discarded' using errcode = 'CP423';
  end if;

  -- El cliente tiene que ser de esta organización: create_quote lo revisa (CP404) con la misma sesión.
  select c.quote_id, c.number_display into v_quote, v_number from public.create_quote(p_customer_id, p_creation_key) c;

  -- create_quote devuelve la MISMA cotización si esa clave ya la usó esta persona. Esa cotización no puede ser
  -- una que ya avanzó ni una que ya nació de otra solicitud: no se amarra a esta.
  select q.status, q.source_request_id into v_qstatus, v_qsource
    from public.quotes q where q.tenant_id = v_tenant and q.id = v_quote;
  if v_qstatus is distinct from 'draft' or v_qsource is not null then
    raise exception 'creation_key_reused' using errcode = 'CP422';
  end if;

  update public.intake_requests
     set status = 'converted', quote_id = v_quote, converted_by = v_uid, converted_at = now(),
         assigned_to = coalesce(r.assigned_to, v_uid),
         assigned_at = case when r.assigned_to is null then now() else r.assigned_at end,
         assigned_by = case when r.assigned_to is null then v_uid else r.assigned_by end
   where tenant_id = v_tenant and id = r.id;
  update public.quotes set source_request_id = r.id where tenant_id = v_tenant and id = v_quote;
  perform app.write_quote_event(v_tenant, v_quote, 'created_from_request', 'user', v_uid,
    jsonb_build_object('request_id', r.id));
  perform app.write_audit(v_tenant, 'user', v_uid, 'intake_request.converted', 'intake_request', r.id, 'success',
    jsonb_build_object('quote_id', v_quote));
  return jsonb_build_object('quote_id', v_quote, 'number_display', v_number, 'converted', true);
end $$;

-- 11. I2 · anonymize_intake_request ----------------------------------------------------------------------------
-- Derecho de supresión (Ley 21.719) de quien llenó el formulario: vacía los datos de contacto cifrados, el mensaje,
-- la dirección y la IP del consentimiento de una solicitud EN CUALQUIER ESTADO, y marca `anonymized_at`. Se
-- conservan los servicios pedidos, las fechas, el vínculo con la cotización y la huella y el texto del consentimiento
-- (historia de la organización; no son datos de la persona). Solo Dueño y Administrador. Repetir no hace nada.
-- Motivo: `data_subject_request` (lo pidió el titular), `wrong_data` (se cargó por error) u `other`.
create function public.anonymize_intake_request(p_request_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant   uuid := app.current_tenant_id();
  v_uid      uuid := auth.uid();
  v_previous text := current_setting('app.intake_anonymize', true);
  r          public.intake_requests;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_request_id is null or p_reason is null
     or p_reason not in ('data_subject_request', 'wrong_data', 'other') then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into r from public.intake_requests where tenant_id = v_tenant and id = p_request_id for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'CP404';
  end if;
  if r.anonymized_at is not null then
    return jsonb_build_object('anonymized', true, 'changed', false);
  end if;
  perform set_config('app.intake_anonymize', 'on', true);
  update public.intake_requests
     set contact_name_enc = null, contact_email_enc = null, contact_phone_enc = null, company_enc = null,
         comuna_enc = null, service_address_enc = null, message_enc = null, contact_email_hash = null,
         consent_ip_enc = null, anonymized_at = now()
   where tenant_id = v_tenant and id = r.id;
  perform set_config('app.intake_anonymize', coalesce(v_previous, ''), true);
  -- Sin datos personales: solo el motivo y en qué estado estaba.
  perform app.write_audit(v_tenant, 'user', v_uid, 'intake_request.anonymized', 'intake_request', r.id, 'success',
    jsonb_build_object('reason', p_reason, 'status', r.status));
  return jsonb_build_object('anonymized', true, 'changed', true);
end $$;
revoke all on function public.anonymize_intake_request(uuid, text) from public, anon, authenticated;
grant execute on function public.anonymize_intake_request(uuid, text) to authenticated;

-- 12. (10) La limpieza por plazo deja constancia, una fila por organización afectada --------------------------------
create or replace function app.purge_intake_data() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_previous     text := current_setting('app.retention_purge', true);
  v_notices      jsonb;
  v_requests     jsonb;
  v_anonymized   jsonb;
  v_counters     jsonb;
  v_tenant       text;
  v_unconverted_cutoff timestamptz := now() - make_interval(months => app.intake_unconverted_retention_months());
  v_discarded_cutoff   timestamptz := now() - make_interval(days => app.intake_discarded_retention_days());
  v_anonymize_cutoff   timestamptz := now() - make_interval(months => app.intake_converted_anonymize_months());
begin
  perform set_config('app.retention_purge', 'on', true);

  -- Los avisos de las solicitudes que se van a borrar (la solicitud es lo que los ata).
  with d as (
    delete from public.email_messages e
     using public.intake_requests r
     where e.tenant_id = r.tenant_id and e.intake_request_id = r.id
       and e.kind in ('request_assigned', 'request_received')
       and ((r.status in ('new', 'assigned') and r.created_at <= v_unconverted_cutoff)
            or (r.status = 'discarded' and r.discarded_at <= v_discarded_cutoff))
    returning e.tenant_id),
  g as (select tenant_id, count(*) as n from d group by tenant_id)
  select coalesce(jsonb_object_agg(tenant_id::text, n), '{}'::jsonb) into v_notices from g;

  with d as (
    delete from public.intake_requests r
     where (r.status in ('new', 'assigned') and r.created_at <= v_unconverted_cutoff)
        or (r.status = 'discarded' and r.discarded_at <= v_discarded_cutoff)
    returning r.tenant_id),
  g as (select tenant_id, count(*) as n from d group by tenant_id)
  select coalesce(jsonb_object_agg(tenant_id::text, n), '{}'::jsonb) into v_requests from g;

  with d as (
    update public.intake_requests
       set contact_name_enc = null, contact_email_enc = null, contact_phone_enc = null, company_enc = null,
           comuna_enc = null, service_address_enc = null, message_enc = null, contact_email_hash = null,
           consent_ip_enc = null, anonymized_at = now()
     where status = 'converted' and anonymized_at is null and created_at <= v_anonymize_cutoff
    returning tenant_id),
  g as (select tenant_id, count(*) as n from d group by tenant_id)
  select coalesce(jsonb_object_agg(tenant_id::text, n), '{}'::jsonb) into v_anonymized from g;

  with d as (
    delete from public.intake_daily_counters
     where day < app.business_date_of(now()) - app.intake_counters_retention_days()
    returning tenant_id),
  g as (select tenant_id, count(*) as n from d group by tenant_id)
  select coalesce(jsonb_object_agg(tenant_id::text, n), '{}'::jsonb) into v_counters from g;

  -- Constancia: qué se borró o anonimizó, por organización (solo cantidades, ningún dato personal).
  for v_tenant in
    select k from (
      select jsonb_object_keys(v_notices) as k union select jsonb_object_keys(v_requests)
      union select jsonb_object_keys(v_anonymized) union select jsonb_object_keys(v_counters)) x
  loop
    perform app.write_audit(v_tenant::uuid, 'system', null, 'intake_retention.purged', 'tenant', v_tenant::uuid,
      'success', jsonb_build_object(
        'requests_deleted', coalesce((v_requests ->> v_tenant)::integer, 0),
        'notices_deleted', coalesce((v_notices ->> v_tenant)::integer, 0),
        'requests_anonymized', coalesce((v_anonymized ->> v_tenant)::integer, 0),
        'counters_deleted', coalesce((v_counters ->> v_tenant)::integer, 0)));
  end loop;

  -- Se deja el interruptor como estaba (la transacción de quien llama puede seguir).
  perform set_config('app.retention_purge', coalesce(v_previous, ''), true);
  return jsonb_build_object(
    'requests_deleted', (select coalesce(sum(value::integer), 0) from jsonb_each_text(v_requests)),
    'notices_deleted', (select coalesce(sum(value::integer), 0) from jsonb_each_text(v_notices)),
    'requests_anonymized', (select coalesce(sum(value::integer), 0) from jsonb_each_text(v_anonymized)),
    'counters_deleted', (select coalesce(sum(value::integer), 0) from jsonb_each_text(v_counters)));
end $$;
