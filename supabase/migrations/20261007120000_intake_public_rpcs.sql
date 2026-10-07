-- Migración 31 — Funciones del formulario público, solo para el servidor (sprint 4, M31)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261007120000_intake_public_rpcs.down.sql
-- Especificación: docs/arquitectura/sprint-4-formulario-publico.md §1 (M31) y §2; decisión 017.
--
-- Las ejecuta SOLO el servidor de la aplicación con la llave maestra (`service_role`), después de validar
-- el formato del identificador, los límites de tasa, la forma del cuerpo, las trampas y el anti-robot (el
-- "portero", src/lib/intake/gateway.ts). Ni `anon` ni `authenticated` pueden llamarlas. La organización
-- NUNCA es un parámetro: sale de la fila del formulario (o de la solicitud). Nada de lo que devuelven
-- `intake_form_read` o el envío lleva precios, tarifas ni datos de quien llenó el formulario.
--
-- Los resultados esperables (en pausa, tope diario, formulario cambiado...) NO son errores: se devuelven
-- en `result` / `state` para que la pantalla los explique. Código de error propio: CP422 dato inválido,
-- CP404 no encontrado, 42501 sin permiso (los avisos).
--
-- El tope diario va DENTRO de la transacción del envío (con el formulario bloqueado): no depende del
-- limitador de la aplicación, que deja pasar si falla.
--
-- Desviaciones del plan, justificadas:
--  * Los avisos de «tope alcanzado» hablan de un formulario (no de una solicitud): `intake_notice_recipients`
--    e `intake_notice_register` reciben un `p_form_id` opcional (por defecto nulo) para ese tipo.
--  * `intake_form_read` devuelve también `form_id` (el servidor lo necesita para el aviso del tope) y
--    `success_message` (el texto de confirmación que ve el visitante).
--  * El tope de 20 avisos «llegó una solicitud» por organización y día se aplica en la base (en
--    `intake_notice_recipients` y de nuevo en `intake_notice_register`), no solo en la aplicación.
--  * La IP real no se escribe en la auditoría del envío (decisión 5 del plan): el registro lleva solo el
--    formulario y la revisión.

-- 0. Constantes con nombre y ayudas internas --------------------------------------------------
-- Tope diario de solicitudes aceptadas por organización (suma de todos sus formularios).
create function app.intake_org_daily_cap() returns integer language sql immutable as $$ select 300 $$;
-- Avisos «llegó una solicitud» por organización y día.
create function app.intake_request_notices_per_day() returns integer language sql immutable as $$ select 20 $$;
revoke all on function app.intake_org_daily_cap(), app.intake_request_notices_per_day()
  from public, anon, authenticated;

-- ¿Qué día es en Chile en un instante dado? (el cambio de día es a medianoche de Chile, no de UTC)
create function app.business_date_of(p_at timestamptz) returns date
language sql immutable set search_path = '' as $$
  select (p_at at time zone app.business_timezone())::date
$$;
-- Suma 1 al contador del día de Chile de un formulario (crea la fila si no existe). `p_what`: accepted,
-- captcha, rate, cap, paused o invalid.
create function app.intake_count(p_tenant uuid, p_form uuid, p_what text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_what is null or p_what not in ('accepted', 'captcha', 'rate', 'cap', 'paused', 'invalid') then
    raise exception 'invalid_counter' using errcode = 'CP422';
  end if;
  insert into public.intake_daily_counters as c
    (tenant_id, form_id, day, accepted, blocked_captcha, blocked_rate, blocked_cap, blocked_paused, blocked_invalid)
  values
    (p_tenant, p_form, app.business_date_of(now()), (p_what = 'accepted')::integer, (p_what = 'captcha')::integer,
     (p_what = 'rate')::integer, (p_what = 'cap')::integer, (p_what = 'paused')::integer, (p_what = 'invalid')::integer)
  on conflict (tenant_id, form_id, day) do update set
    accepted        = c.accepted + excluded.accepted,
    blocked_captcha = c.blocked_captcha + excluded.blocked_captcha,
    blocked_rate    = c.blocked_rate + excluded.blocked_rate,
    blocked_cap     = c.blocked_cap + excluded.blocked_cap,
    blocked_paused  = c.blocked_paused + excluded.blocked_paused,
    blocked_invalid = c.blocked_invalid + excluded.blocked_invalid;
end $$;
revoke all on function app.intake_count(uuid, uuid, text) from public, anon, authenticated;

-- Dueño y Administradores activos de una organización, con su correo de cuenta.
create function app.intake_managers(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', x.user_id, 'email', x.email) order by x.email), '[]'::jsonb)
    from (
      select u.id as user_id, u.email::text as email
        from public.members m join auth.users u on u.id = m.user_id
       where m.tenant_id = p_tenant and m.status = 'active' and m.role in ('owner', 'admin') and u.email is not null
    ) x
$$;
revoke all on function app.intake_managers(uuid) from public, anon, authenticated;

-- 1. intake_form_read --------------------------------------------------------------------------
-- SOLO LEE. state: ok | paused | not_found. Un formulario en borrador o archivado, o de una organización
-- archivada, no existe para el público. En pausa solo entrega el contacto y la marca de la organización.
-- No devuelve el servicio del catálogo al que apunta cada ítem, el tope diario, el nombre interno, el
-- autor ni nada de precios.
create function public.intake_form_read(p_public_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f      public.intake_forms;
  t      public.tenants;
  v_org  jsonb;
  v_base jsonb;
begin
  if p_public_id is null or p_public_id !~ '^[A-Za-z0-9_-]{22}$' then
    return jsonb_build_object('state', 'not_found');
  end if;
  select * into f from public.intake_forms where public_id = p_public_id;
  if not found or f.status not in ('published', 'paused') then
    return jsonb_build_object('state', 'not_found');
  end if;
  select * into t from public.tenants where tenant_id = f.tenant_id;
  if not found or t.status <> 'active' or t.kind <> 'organization' then
    return jsonb_build_object('state', 'not_found');
  end if;

  v_org := jsonb_build_object(
    'name', t.name,
    'contact_email', t.contact_email,
    'contact_phone', t.contact_phone);
  v_base := jsonb_build_object(
    'tenant_id', t.tenant_id,
    'form_id', f.id,
    'title', f.title,
    'org', v_org,
    'brand', jsonb_build_object('primary_color', t.brand_primary_color, 'secondary_color', t.brand_secondary_color),
    'logo_path', t.logo_path);
  if f.status = 'paused' then
    return v_base || jsonb_build_object('state', 'paused');
  end if;

  return v_base || jsonb_build_object(
    'state', 'ok',
    'revision', f.revision,
    'intro', f.intro,
    'success_message', f.success_message,
    'fields', f.fields,
    'privacy_policy_url', f.privacy_policy_url,
    'embed_origins', to_jsonb(f.embed_origins),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'name', i.public_name, 'description', i.public_description, 'unit', i.unit,
               'quantity_mode', i.quantity_mode, 'min_qty_milli', i.min_qty_milli, 'max_qty_milli', i.max_qty_milli)
             order by i.position, i.id)
        from public.intake_form_items i
       where i.tenant_id = f.tenant_id and i.form_id = f.id and i.is_active), '[]'::jsonb));
end $$;
revoke all on function public.intake_form_read(text) from public, anon, authenticated;
grant execute on function public.intake_form_read(text) to service_role;

-- 2. intake_request_submit ---------------------------------------------------------------------
-- Una solicitud nueva, en una sola transacción y con el formulario bloqueado. Orden: (1) el formulario
-- (la organización sale de su fila); (2) la misma clave de envío devuelve la misma solicitud; (3) no
-- publicado; (4) revisión distinta; (5) servicios (se revalidan contra ESTE formulario y el nombre y la
-- unidad se reescriben desde la base); (6) datos obligatorios; (7) topes; (8) se guarda y se cuenta;
-- (9) auditoría.
-- p_items: [{form_item_id, quantity_milli}].
-- result: ok | paused | not_found | form_changed | invalid_items | invalid_data | cap_reached.
create function public.intake_request_submit(
  p_public_id text, p_request_id uuid, p_submit_key uuid, p_form_revision integer,
  p_contact_name_enc text, p_contact_email_enc text, p_contact_phone_enc text, p_company_enc text,
  p_comuna_enc text, p_service_address_enc text, p_message_enc text, p_contact_email_hash text,
  p_desired_date date, p_items jsonb, p_consent_template_version text, p_consent_text_sha256 text,
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
  v_first    boolean;
  v_present  record;
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
     or p_consent_template_version is null or p_consent_text_sha256 is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if p_contact_email_hash !~ '^[0-9a-f]{64}$' or p_consent_text_sha256 !~ '^[0-9a-f]{64}$'
     or char_length(p_consent_template_version) not between 1 and 40 then
    raise exception 'invalid_hash' using errcode = 'CP422';
  end if;
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
    perform app.intake_count(f.tenant_id, f.id, 'cap');
    -- El aviso al equipo sale solo la primera vez del día.
    update public.intake_daily_counters set cap_notified_at = now()
     where tenant_id = f.tenant_id and form_id = f.id and day = v_today and cap_notified_at is null
    returning true into v_first;
    return jsonb_build_object('result', 'cap_reached', 'notify_cap', coalesce(v_first, false),
                              'tenant_id', f.tenant_id, 'form_id', f.id, 'form_name', f.name);
  end if;

  -- (8) Se guarda y se cuenta.
  insert into public.intake_requests
    (id, tenant_id, form_id, contact_name_enc, contact_email_enc, contact_phone_enc, company_enc, comuna_enc,
     service_address_enc, message_enc, contact_email_hash, desired_date, items, form_revision, submit_key,
     consent_template_version, consent_text_sha256, consent_ip_enc)
  values
    (p_request_id, f.tenant_id, f.id, p_contact_name_enc, p_contact_email_enc, p_contact_phone_enc, p_company_enc,
     p_comuna_enc, p_service_address_enc, p_message_enc, p_contact_email_hash, p_desired_date, v_stored,
     f.revision, p_submit_key, p_consent_template_version, p_consent_text_sha256, p_consent_ip_enc);
  perform app.intake_count(f.tenant_id, f.id, 'accepted');

  -- (9) Auditoría: sin la IP, el nombre, el correo ni el mensaje.
  insert into public.audit_log (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, result, details)
  values (f.tenant_id, 'public', null, 'intake_request.received', 'intake_request', p_request_id, 'success',
          jsonb_build_object('form_id', f.id, 'form_revision', f.revision));

  return jsonb_build_object('result', 'ok', 'replayed', false, 'request_id', p_request_id,
                            'tenant_id', f.tenant_id, 'form_id', f.id, 'form_name', f.name);
end $$;
revoke all on function public.intake_request_submit(text, uuid, uuid, integer, text, text, text, text, text, text, text, text, date, jsonb, text, text, text)
  from public, anon, authenticated;
grant execute on function public.intake_request_submit(text, uuid, uuid, integer, text, text, text, text, text, text, text, text, date, jsonb, text, text, text)
  to service_role;

-- 3. intake_record_block -----------------------------------------------------------------------
-- Suma un envío bloqueado (anti-robot, límite de tasa, tope, pausa o datos inválidos) al contador del día.
-- Si el identificador no existe no hace nada: así un atacante no cuenta nada a una organización ajena
-- ni descubre qué formularios existen.
create function public.intake_record_block(p_public_id text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f public.intake_forms;
begin
  if p_reason is null or p_reason not in ('captcha', 'rate', 'cap', 'paused', 'invalid') then
    raise exception 'invalid_reason' using errcode = 'CP422';
  end if;
  if p_public_id is null or p_public_id !~ '^[A-Za-z0-9_-]{22}$' then
    return jsonb_build_object('recorded', false);
  end if;
  select * into f from public.intake_forms where public_id = p_public_id;
  if not found or f.status = 'archived' then
    return jsonb_build_object('recorded', false);
  end if;
  perform app.intake_count(f.tenant_id, f.id, p_reason);
  return jsonb_build_object('recorded', true);
end $$;
revoke all on function public.intake_record_block(text, text) from public, anon, authenticated;
grant execute on function public.intake_record_block(text, text) to service_role;

-- 4. Avisos al equipo (sin datos de quien llenó el formulario) ------------------------------------
-- Destinatarios ya filtrados por la base:
--   request_assigned   → la persona asignada, si sigue como miembro activo; si no, Dueño y Administradores.
--   request_received   → Dueño y Administradores activos (hasta 20 solicitudes avisadas por día y organización).
--   intake_cap_reached → Dueño y Administradores activos; es de un formulario, así que lleva `p_form_id`.
create function public.intake_notice_recipients(p_request_id uuid, p_kind text, p_form_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r          public.intake_requests;
  f          public.intake_forms;
  t          public.tenants;
  v_tenant   uuid;
  v_audience text;
  v_recipients jsonb;
  v_assignee_ok boolean;
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
    v_audience := 'managers';
    v_recipients := app.intake_managers(v_tenant);
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
    if p_kind = 'request_assigned' then
      select exists (
        select 1 from public.members m join auth.users u on u.id = m.user_id
         where m.tenant_id = v_tenant and m.user_id = r.assigned_to and m.status = 'active' and u.email is not null
      ) into v_assignee_ok;
      if coalesce(v_assignee_ok, false) then
        v_audience := 'assignee';
        select jsonb_build_array(jsonb_build_object('user_id', u.id, 'email', u.email::text)) into v_recipients
          from auth.users u where u.id = r.assigned_to;
      else
        v_audience := 'managers';
        v_recipients := app.intake_managers(v_tenant);
      end if;
    else
      v_audience := 'managers';
      v_recipients := app.intake_managers(v_tenant);
      -- Tope de avisos del día: solo cuentan las solicitudes distintas ya avisadas (esta, si ya lo estaba, no suma).
      select count(distinct e.intake_request_id) into v_notified
        from public.email_messages e
       where e.tenant_id = v_tenant and e.kind = 'request_received'
         and e.intake_request_id <> r.id
         and e.created_at >= (app.business_date_of(now())::timestamp at time zone app.business_timezone());
      if v_notified >= app.intake_request_notices_per_day() then
        v_limited := true;
        v_recipients := '[]'::jsonb;
      end if;
    end if;
  end if;
  select * into t from public.tenants where tenant_id = v_tenant;
  return jsonb_build_object(
    'kind', p_kind, 'audience', v_audience, 'recipients', v_recipients, 'limited', v_limited,
    'tenant_id', v_tenant, 'tenant_name', t.name, 'form_id', f.id, 'form_name', f.name,
    'request_id', p_request_id);
end $$;
revoke all on function public.intake_notice_recipients(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.intake_notice_recipients(uuid, text, uuid) to service_role;

-- Registrar el aviso (antes de enviarlo).
create function public.intake_notice_register(
  p_email_id uuid, p_request_id uuid, p_kind text, p_to_user_id uuid, p_to_email_enc text, p_to_email_hash text,
  p_form_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r        public.intake_requests;
  f        public.intake_forms;
  v_tenant uuid;
  v_notified integer;
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
  end if;
  -- El destinatario tiene que seguir siendo miembro activo de esa organización.
  if not exists (select 1 from public.members m
                  where m.tenant_id = v_tenant and m.user_id = p_to_user_id and m.status = 'active') then
    raise exception 'recipient_not_member' using errcode = '42501';
  end if;
  if p_kind = 'request_received' then
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
  return jsonb_build_object('registered', true);
end $$;
revoke all on function public.intake_notice_register(uuid, uuid, text, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.intake_notice_register(uuid, uuid, text, uuid, text, text, uuid) to service_role;

-- Cerrar el aviso: enviado o fallido.
create function public.intake_notice_settle(
  p_email_id uuid, p_provider text, p_provider_message_id text, p_error_code text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_mail public.email_messages;
begin
  if p_email_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into v_mail from public.email_messages
   where id = p_email_id and kind in ('request_assigned', 'request_received', 'intake_cap_reached') for update;
  if not found then
    raise exception 'email_not_found' using errcode = 'CP404';
  end if;
  if v_mail.status <> 'pending' then
    return jsonb_build_object('status', 'already_settled');
  end if;
  if p_error_code is not null then
    if p_error_code !~ '^[A-Za-z0-9_.:-]{1,60}$' then
      raise exception 'invalid_error_code' using errcode = 'CP422';
    end if;
    update public.email_messages set status = 'failed', error_code = p_error_code, status_at = now()
     where tenant_id = v_mail.tenant_id and id = v_mail.id;
    return jsonb_build_object('status', 'failed');
  end if;
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,30}$' or p_provider = 'pending'
     or p_provider_message_id is null or char_length(p_provider_message_id) not between 1 and 200 then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  update public.email_messages
     set provider = p_provider, provider_message_id = p_provider_message_id,
         status = 'sent', status_at = now(), sent_at = now()
   where tenant_id = v_mail.tenant_id and id = v_mail.id;
  return jsonb_build_object('status', 'sent');
end $$;
revoke all on function public.intake_notice_settle(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.intake_notice_settle(uuid, text, text, text) to service_role;
