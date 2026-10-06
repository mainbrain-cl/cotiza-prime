-- Migración 23 — Funciones para enviar la cotización (sprint 3, M22)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261006120000_quote_send_rpcs.down.sql
-- Especificación: docs/arquitectura/sprint-3-envio-y-enlace.md §1 (M22) y §4.
--
-- Todas son SECURITY DEFINER con search_path vacío; la organización sale solo de
-- app.current_tenant_id() (nunca de un argumento) y se ejecutan solo con sesión (`authenticated`).
-- El envío real del correo y la subida del PDF los hace el servidor entre `prepare_quote_send`,
-- `attach_quote_package_document` y `confirm_email_dispatch` / `fail_email_dispatch`.
--
-- Códigos de error propios (SQLSTATE): CP404 no encontrado · CP409 choque (revisión distinta, otro
-- envío en curso o candado perdido) · CP422 dato inválido · CP423 el estado ya no lo permite ·
-- CP429 tope de reenvíos · 42501 sin permiso.
--
-- Desviación del plan: el proveedor de correo no se conoce al preparar el envío; el correo nace con
-- proveedor 'pending' y `confirm_email_dispatch` lo fija (la migración 22 lo permite una sola vez).

-- 0. Constantes con nombre y ayudas internas --------------------------------------------------
-- Segundos que dura el candado de envío (PROYECTO: el PDF puede tardar decenas de segundos).
create function app.send_lock_seconds() returns integer
language sql immutable as $$ select 120 $$;
-- Topes de reenvío por cotización: por día y en total.
create function app.resend_max_per_day() returns integer
language sql immutable as $$ select 5 $$;
create function app.resend_max_total() returns integer
language sql immutable as $$ select 20 $$;
revoke all on function app.send_lock_seconds(), app.resend_max_per_day(), app.resend_max_total()
  from public, anon, authenticated;

-- Registro de auditoría desde una función (el origen y la correlación vienen de las cabeceras que
-- reenvía la aplicación: son orientativos; para el enlace público se pasa la IP real).
create function app.write_audit(
  p_tenant uuid, p_actor_type text, p_actor_user_id uuid, p_action text, p_resource_type text,
  p_resource_id uuid, p_result text, p_details jsonb default '{}'::jsonb, p_origin_ip inet default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_headers json := nullif(current_setting('request.headers', true), '')::json;
  v_ip      inet := p_origin_ip;
  v_corr    uuid;
begin
  if v_ip is null then
    begin v_ip := nullif(v_headers ->> 'x-cp-client-ip', '')::inet;
    exception when others then v_ip := null; end;
  end if;
  begin v_corr := nullif(v_headers ->> 'x-cp-request-id', '')::uuid;
  exception when others then v_corr := null; end;
  insert into public.audit_log
    (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, result,
     origin_ip, user_agent, correlation_id, details)
  values
    (p_tenant, p_actor_type, p_actor_user_id, p_action, p_resource_type, p_resource_id, p_result,
     v_ip, left(nullif(v_headers ->> 'user-agent', ''), 300), v_corr, coalesce(p_details, '{}'::jsonb));
end $$;
revoke all on function app.write_audit(uuid, text, uuid, text, text, uuid, text, jsonb, inet)
  from public, anon, authenticated;

-- Evento de la línea de tiempo (sin datos personales).
create function app.write_quote_event(
  p_tenant uuid, p_quote_id uuid, p_type text, p_actor_type text, p_actor_user_id uuid,
  p_data jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = '' as $$
  insert into public.quote_events (tenant_id, quote_id, type, actor_type, actor_user_id, data)
  values (p_tenant, p_quote_id, p_type, p_actor_type, p_actor_user_id, coalesce(p_data, '{}'::jsonb))
$$;
revoke all on function app.write_quote_event(uuid, uuid, text, text, uuid, jsonb)
  from public, anon, authenticated;

-- Deja un paquete que quedó a medias como abandonado: su correo falla, su enlace se revoca y el candado se suelta.
create function app.abandon_package(p_tenant uuid, p_package_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_quote uuid;
begin
  update public.email_messages
     set status = 'failed', status_at = now(), error_code = 'abandoned'
   where tenant_id = p_tenant and package_id = p_package_id and kind = 'quote' and status = 'pending';
  update public.share_links
     set revoked_at = now(), revoke_reason = 'failed_attempt'
   where tenant_id = p_tenant and package_id = p_package_id and revoked_at is null and activated_at is null;
  update public.quote_packages set state = 'abandoned'
   where tenant_id = p_tenant and id = p_package_id and state in ('preparing', 'ready')
  returning quote_id into v_quote;
  update public.quotes set send_lock_key = null, send_lock_until = null
   where tenant_id = p_tenant and id = v_quote;
end $$;
revoke all on function app.abandon_package(uuid, uuid) from public, anon, authenticated;

-- 1. prepare_quote_send ---------------------------------------------------------------------
-- Congela lo que se enviará: crea el paquete (preparing), el enlace (inactivo) y el correo (pending)
-- y toma el candado de envío. Devuelve {status: 'prepared' | 'in_progress' | 'already_sent', ...}.
create function public.prepare_quote_send(
  p_quote_id uuid, p_expected_revision integer, p_send_key uuid, p_package_id uuid,
  p_email_message_id uuid, p_share_link_id uuid, p_token_sha256 text, p_email_subject text,
  p_email_body_md text, p_to_email_enc text, p_to_email_hash text, p_customer_snapshot_enc text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  -- Caracteres de control, salvo tabulación, salto de línea y retorno de carro.
  c_control_chars constant text := '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]';
  v_tenant  uuid := app.current_tenant_id();
  v_uid     uuid := auth.uid();
  q         public.quotes;
  v_live    public.quote_packages;
  v_today   date := app.current_business_date();
  v_valid   date;
  v_days    integer;
  v_lines   integer;
  v_lock_until timestamptz := now() + make_interval(secs => app.send_lock_seconds());
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin', 'sales') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_quote_id is null or p_expected_revision is null or p_send_key is null or p_package_id is null
     or p_email_message_id is null or p_share_link_id is null or p_token_sha256 is null
     or p_email_subject is null or p_email_body_md is null or p_to_email_enc is null
     or p_to_email_hash is null or p_customer_snapshot_enc is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if p_token_sha256 !~ '^[0-9a-f]{64}$' or p_to_email_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_hash' using errcode = 'CP422';
  end if;
  if char_length(p_email_subject) not between 1 and 150 or p_email_subject ~ '[\r\n]'
     or p_email_subject ~ c_control_chars then
    raise exception 'invalid_subject' using errcode = 'CP422';
  end if;
  if char_length(p_email_body_md) > 5000 or p_email_body_md ~ c_control_chars then
    raise exception 'invalid_body' using errcode = 'CP422';
  end if;
  if char_length(p_to_email_enc) not between 1 and 2000
     or char_length(p_customer_snapshot_enc) not between 1 and 8000 then
    raise exception 'invalid_encrypted_value' using errcode = 'CP422';
  end if;

  select * into q from public.quotes where tenant_id = v_tenant and id = p_quote_id for update;
  if not found then
    raise exception 'quote_not_found' using errcode = 'CP404';
  end if;
  -- Envía solo el autor (decisión 009).
  if q.created_by <> v_uid then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Un paquete vivo (en preparación, listo o enviado) de esta cotización.
  select * into v_live from public.quote_packages
   where tenant_id = v_tenant and quote_id = q.id and state in ('preparing', 'ready', 'sent');
  if found then
    if v_live.state = 'sent' then
      if v_live.send_key = p_send_key then
        return jsonb_build_object('status', 'already_sent', 'package_id', v_live.id);
      end if;
      raise exception 'not_editable' using errcode = 'CP423';
    end if;
    if q.send_lock_until is not null and q.send_lock_until > now() then
      -- Otro envío está en curso: el mismo clic repetido recibe "en curso"; otra persona, un choque.
      if v_live.send_key = p_send_key then
        return jsonb_build_object('status', 'in_progress', 'package_id', v_live.id);
      end if;
      raise exception 'send_in_progress' using errcode = 'CP409';
    end if;
    -- El envío anterior murió a medias (candado vencido): se abandona y se parte de nuevo.
    perform app.abandon_package(v_tenant, v_live.id);
  end if;

  if q.status <> 'draft' then
    raise exception 'not_editable' using errcode = 'CP423';
  end if;
  if q.revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = 'CP409';
  end if;
  select count(*) into v_lines from public.quote_items where tenant_id = v_tenant and quote_id = q.id;
  if v_lines < 1 then
    raise exception 'no_lines' using errcode = 'CP422';
  end if;
  if not exists (select 1 from public.customers c
                  where c.tenant_id = v_tenant and c.id = q.customer_id and c.anonymized_at is null) then
    raise exception 'customer_anonymized' using errcode = 'CP422';
  end if;

  -- Vigencia: por fecha (no pasada) o en días desde hoy; sin elegir, la de la organización.
  if q.validity_mode = 'date' then
    v_valid := q.valid_until;
    if v_valid is null or v_valid < v_today then
      raise exception 'validity_past' using errcode = 'CP422';
    end if;
  else
    v_days := coalesce(q.validity_days,
                       (select t.default_validity_days from public.tenants t where t.tenant_id = v_tenant));
    v_valid := v_today + v_days;
  end if;

  update public.quotes set send_lock_key = p_send_key, send_lock_until = v_lock_until
   where tenant_id = v_tenant and id = q.id;

  insert into public.quote_packages
    (id, tenant_id, quote_id, send_key, issue_date, valid_until, email_subject, email_body_md,
     customer_snapshot_enc, created_by)
  values
    (p_package_id, v_tenant, q.id, p_send_key, v_today, v_valid, p_email_subject, p_email_body_md,
     p_customer_snapshot_enc, v_uid);
  -- El enlace y el correo se apuntan entre sí: la relación se revisa al confirmar la transacción.
  insert into public.share_links (id, tenant_id, quote_id, package_id, email_message_id, token_sha256)
  values (p_share_link_id, v_tenant, q.id, p_package_id, p_email_message_id, p_token_sha256);
  insert into public.email_messages
    (id, tenant_id, quote_id, package_id, share_link_id, kind, to_email_enc, to_email_hash, provider, created_by)
  values
    (p_email_message_id, v_tenant, q.id, p_package_id, p_share_link_id, 'quote', p_to_email_enc,
     p_to_email_hash, 'pending', v_uid);

  return jsonb_build_object('status', 'prepared', 'package_id', p_package_id, 'quote_id', q.id,
                            'issue_date', v_today, 'valid_until', v_valid, 'send_lock_until', v_lock_until);
end $$;
revoke all on function public.prepare_quote_send(uuid, integer, uuid, uuid, uuid, uuid, text, text, text, text, text, text)
  from public, anon;
grant execute on function public.prepare_quote_send(uuid, integer, uuid, uuid, uuid, uuid, text, text, text, text, text, text)
  to authenticated;

-- 2. attach_quote_package_document ----------------------------------------------------------
-- Registra el PDF (y el logo) que el servidor ya subió a Storage y deja el paquete listo.
create function public.attach_quote_package_document(
  p_package_id uuid, p_pdf_path text, p_pdf_sha256 text, p_pdf_bytes integer, p_logo_path text,
  p_document_snapshot jsonb, p_content_sha256 text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  v_pkg    public.quote_packages;
  q        public.quotes;
  v_prefix text;
  v_size   text;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin', 'sales') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_package_id is null or p_pdf_path is null or p_pdf_sha256 is null or p_pdf_bytes is null
     or p_document_snapshot is null or p_content_sha256 is null
     or jsonb_typeof(p_document_snapshot) is distinct from 'object' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if p_pdf_sha256 !~ '^[0-9a-f]{64}$' or p_content_sha256 !~ '^[0-9a-f]{64}$'
     or p_pdf_bytes not between 1 and 20971520
     or pg_column_size(p_document_snapshot) > 262144 then
    raise exception 'invalid_document' using errcode = 'CP422';
  end if;

  select * into v_pkg from public.quote_packages where tenant_id = v_tenant and id = p_package_id for update;
  if not found then
    raise exception 'package_not_found' using errcode = 'CP404';
  end if;
  select * into q from public.quotes where tenant_id = v_tenant and id = v_pkg.quote_id for update;
  if q.created_by <> v_uid then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_pkg.state <> 'preparing' then
    raise exception 'package_not_preparing' using errcode = 'CP423';
  end if;
  -- Debe seguir siendo el mismo envío (ni abandonado ni tomado por otro).
  if q.send_lock_key is distinct from v_pkg.send_key then
    raise exception 'send_lock_lost' using errcode = 'CP409';
  end if;

  -- Las rutas son siempre {organización}/{cotización}/{paquete}: nada de otra carpeta ni de otra organización.
  v_prefix := v_tenant::text || '/' || v_pkg.quote_id::text || '/' || v_pkg.id::text;
  if p_pdf_path <> v_prefix || '.pdf' then
    raise exception 'invalid_pdf_path' using errcode = 'CP422';
  end if;
  select o.metadata ->> 'size' into v_size from storage.objects o
   where o.bucket_id = 'quote-documents' and o.name = p_pdf_path;
  if not found then
    raise exception 'pdf_not_uploaded' using errcode = 'CP422';
  end if;
  if v_size is not null and v_size <> p_pdf_bytes::text then
    raise exception 'pdf_size_mismatch' using errcode = 'CP422';
  end if;
  if p_logo_path is not null then
    if p_logo_path !~ ('^' || v_prefix || '-logo\.(png|jpg|svg)$')
       or not exists (select 1 from storage.objects o
                       where o.bucket_id = 'quote-documents' and o.name = p_logo_path) then
      raise exception 'invalid_logo' using errcode = 'CP422';
    end if;
  end if;

  update public.quote_packages set
    pdf_path = p_pdf_path, pdf_sha256 = p_pdf_sha256, pdf_bytes = p_pdf_bytes, logo_path = p_logo_path,
    document_snapshot = p_document_snapshot, content_sha256 = p_content_sha256, state = 'ready'
  where tenant_id = v_tenant and id = v_pkg.id;
end $$;
revoke all on function public.attach_quote_package_document(uuid, text, text, integer, text, jsonb, text)
  from public, anon;
grant execute on function public.attach_quote_package_document(uuid, text, text, integer, text, jsonb, text)
  to authenticated;

-- 3. confirm_email_dispatch -----------------------------------------------------------------
-- El proveedor aceptó el correo: queda enviado, el enlace se activa y, si es el primer envío, la
-- cotización pasa a "Enviada".
create function public.confirm_email_dispatch(
  p_email_message_id uuid, p_provider text, p_provider_message_id text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  v_mail   public.email_messages;
  v_pkg    public.quote_packages;
  q        public.quotes;
  v_default smallint;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin', 'sales') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_email_message_id is null or p_provider is null or p_provider !~ '^[a-z0-9_]{2,30}$'
     or p_provider = 'pending'
     or p_provider_message_id is null or char_length(p_provider_message_id) not between 1 and 200 then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;

  select * into v_mail from public.email_messages where tenant_id = v_tenant and id = p_email_message_id for update;
  if not found then
    raise exception 'email_not_found' using errcode = 'CP404';
  end if;
  if v_mail.kind not in ('quote', 'quote_resend') then
    raise exception 'unsupported_kind' using errcode = 'CP422';
  end if;
  select * into q from public.quotes where tenant_id = v_tenant and id = v_mail.quote_id for update;
  -- Primer envío: el autor. Reenvío: el autor, el Dueño o un Administrador.
  if q.created_by <> v_uid and not (v_mail.kind = 'quote_resend' and app.has_role('owner', 'admin')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Repetido (reintento tras una mala conexión): la misma respuesta, sin tocar nada.
  if v_mail.status <> 'pending' then
    if v_mail.provider = p_provider and v_mail.provider_message_id is not distinct from p_provider_message_id
       and v_mail.status in ('sent', 'delivered') then
      return jsonb_build_object('status', 'already_confirmed');
    end if;
    raise exception 'email_not_pending' using errcode = 'CP423';
  end if;

  select * into v_pkg from public.quote_packages where tenant_id = v_tenant and id = v_mail.package_id for update;
  if v_mail.kind = 'quote' then
    if v_pkg.state <> 'ready' or q.status <> 'draft' or q.send_lock_key is distinct from v_pkg.send_key then
      raise exception 'send_not_ready' using errcode = 'CP423';
    end if;
  else
    if v_pkg.state <> 'sent' or q.status not in ('sent', 'viewed') then
      raise exception 'resend_not_allowed' using errcode = 'CP423';
    end if;
  end if;

  update public.email_messages
     set provider = p_provider, provider_message_id = p_provider_message_id,
         status = 'sent', status_at = now(), sent_at = now()
   where tenant_id = v_tenant and id = v_mail.id;
  update public.share_links set activated_at = now()
   where tenant_id = v_tenant and id = v_mail.share_link_id and activated_at is null and revoked_at is null;

  if v_mail.kind = 'quote' then
    update public.quote_packages set state = 'sent' where tenant_id = v_tenant and id = v_pkg.id;
    -- Una cotización sin vigencia elegida queda con la de la organización, en días (ya congelada en el paquete).
    if q.validity_mode is null then
      select t.default_validity_days into v_default from public.tenants t where t.tenant_id = v_tenant;
      update public.quotes set validity_mode = 'days', validity_days = v_default
       where tenant_id = v_tenant and id = q.id;
    end if;
    update public.quotes set
      status = 'sent', sent_at = now(), valid_until = v_pkg.valid_until, current_package_id = v_pkg.id,
      send_lock_key = null, send_lock_until = null
    where tenant_id = v_tenant and id = q.id;
    perform app.write_quote_event(v_tenant, q.id, 'sent', 'user', v_uid,
      jsonb_build_object('package_id', v_pkg.id, 'email_message_id', v_mail.id));
    perform app.write_audit(v_tenant, 'user', v_uid, 'quote.sent', 'quote', q.id, 'success',
      jsonb_build_object('package_id', v_pkg.id, 'email_message_id', v_mail.id));
  else
    perform app.write_quote_event(v_tenant, q.id, 'resent', 'user', v_uid,
      jsonb_build_object('email_message_id', v_mail.id));
    perform app.write_audit(v_tenant, 'user', v_uid, 'quote.resent', 'quote', q.id, 'success',
      jsonb_build_object('email_message_id', v_mail.id));
  end if;
  return jsonb_build_object('status', 'confirmed');
end $$;
revoke all on function public.confirm_email_dispatch(uuid, text, text) from public, anon;
grant execute on function public.confirm_email_dispatch(uuid, text, text) to authenticated;

-- 4. fail_email_dispatch --------------------------------------------------------------------
-- El correo no salió: el correo y el paquete quedan fallidos, el enlace sin activar queda revocado y
-- se suelta el candado. La cotización NO cambia de estado (sigue Borrador, o Enviada si era reenvío).
create function public.fail_email_dispatch(p_email_message_id uuid, p_error_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  v_mail   public.email_messages;
  q        public.quotes;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin', 'sales') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_email_message_id is null or p_error_code is null or p_error_code !~ '^[A-Za-z0-9_.:-]{1,60}$' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into v_mail from public.email_messages where tenant_id = v_tenant and id = p_email_message_id for update;
  if not found then
    raise exception 'email_not_found' using errcode = 'CP404';
  end if;
  if v_mail.kind not in ('quote', 'quote_resend') then
    raise exception 'unsupported_kind' using errcode = 'CP422';
  end if;
  select * into q from public.quotes where tenant_id = v_tenant and id = v_mail.quote_id for update;
  if q.created_by <> v_uid and not (v_mail.kind = 'quote_resend' and app.has_role('owner', 'admin')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_mail.status = 'failed' then
    return;   -- repetido: ya quedó registrado
  end if;
  if v_mail.status <> 'pending' then
    raise exception 'email_not_pending' using errcode = 'CP423';
  end if;

  update public.email_messages set status = 'failed', status_at = now(), error_code = p_error_code
   where tenant_id = v_tenant and id = v_mail.id;
  update public.share_links set revoked_at = now(), revoke_reason = 'failed_attempt'
   where tenant_id = v_tenant and id = v_mail.share_link_id and activated_at is null and revoked_at is null;
  if v_mail.kind = 'quote' then
    update public.quote_packages set state = 'failed'
     where tenant_id = v_tenant and id = v_mail.package_id and state in ('preparing', 'ready');
    update public.quotes set send_lock_key = null, send_lock_until = null
     where tenant_id = v_tenant and id = q.id and send_lock_key is not null
       and send_lock_key = (select p.send_key from public.quote_packages p
                             where p.tenant_id = v_tenant and p.id = v_mail.package_id);
  end if;
  perform app.write_quote_event(v_tenant, q.id, 'send_failed', 'user', v_uid,
    jsonb_build_object('code', p_error_code));
  perform app.write_audit(v_tenant, 'user', v_uid, 'quote.send_failed', 'quote', q.id, 'failure',
    jsonb_build_object('code', p_error_code, 'email_message_id', v_mail.id));
end $$;
revoke all on function public.fail_email_dispatch(uuid, text) from public, anon;
grant execute on function public.fail_email_dispatch(uuid, text) to authenticated;

-- 5. prepare_quote_resend -------------------------------------------------------------------
-- Reenvía el MISMO paquete y el MISMO PDF con un enlace nuevo. Devuelve lo que el servidor necesita
-- para armar el correo; luego confirma con confirm_email_dispatch.
create function public.prepare_quote_resend(
  p_quote_id uuid, p_resend_key uuid, p_email_message_id uuid, p_share_link_id uuid,
  p_token_sha256 text, p_to_email_enc text, p_to_email_hash text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  q        public.quotes;
  v_pkg    public.quote_packages;
  v_prev   public.email_messages;
  v_day    integer;
  v_total  integer;
  v_today  date := app.current_business_date();
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin', 'sales') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_quote_id is null or p_resend_key is null or p_email_message_id is null or p_share_link_id is null
     or p_token_sha256 is null or p_to_email_enc is null or p_to_email_hash is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if p_token_sha256 !~ '^[0-9a-f]{64}$' or p_to_email_hash !~ '^[0-9a-f]{64}$'
     or char_length(p_to_email_enc) not between 1 and 2000 then
    raise exception 'invalid_value' using errcode = 'CP422';
  end if;

  select * into q from public.quotes where tenant_id = v_tenant and id = p_quote_id for update;
  if not found then
    raise exception 'quote_not_found' using errcode = 'CP404';
  end if;
  -- Reenvía el autor, el Dueño o un Administrador.
  if q.created_by <> v_uid and not app.has_role('owner', 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_pkg from public.quote_packages
   where tenant_id = v_tenant and id = q.current_package_id and state = 'sent';
  if not found or q.status not in ('sent', 'viewed') then
    raise exception 'resend_not_allowed' using errcode = 'CP423';
  end if;

  -- Repetido (el mismo correo ya se preparó): se devuelve igual, sin crear otro.
  select * into v_prev from public.email_messages where tenant_id = v_tenant and id = p_email_message_id;
  if found then
    if v_prev.quote_id <> q.id or v_prev.kind <> 'quote_resend' then
      raise exception 'invalid_value' using errcode = 'CP422';
    end if;
    return jsonb_build_object('status', 'replayed', 'package_id', v_pkg.id, 'pdf_path', v_pkg.pdf_path,
                              'pdf_sha256', v_pkg.pdf_sha256, 'email_subject', v_pkg.email_subject,
                              'email_body_md', v_pkg.email_body_md, 'valid_until', v_pkg.valid_until);
  end if;

  if q.valid_until is not null and q.valid_until < v_today then
    raise exception 'quote_expired' using errcode = 'CP422';
  end if;

  select count(*) filter (where (e.created_at at time zone app.business_timezone())::date = v_today), count(*)
    into v_day, v_total
    from public.email_messages e
   where e.tenant_id = v_tenant and e.quote_id = q.id and e.kind = 'quote_resend';
  if v_day >= app.resend_max_per_day() or v_total >= app.resend_max_total() then
    raise exception 'resend_limit' using errcode = 'CP429';
  end if;

  insert into public.share_links (id, tenant_id, quote_id, package_id, email_message_id, token_sha256)
  values (p_share_link_id, v_tenant, q.id, v_pkg.id, p_email_message_id, p_token_sha256);
  insert into public.email_messages
    (id, tenant_id, quote_id, package_id, share_link_id, kind, to_email_enc, to_email_hash, provider, created_by)
  values
    (p_email_message_id, v_tenant, q.id, v_pkg.id, p_share_link_id, 'quote_resend', p_to_email_enc,
     p_to_email_hash, 'pending', v_uid);

  return jsonb_build_object('status', 'prepared', 'package_id', v_pkg.id, 'pdf_path', v_pkg.pdf_path,
                            'pdf_sha256', v_pkg.pdf_sha256, 'email_subject', v_pkg.email_subject,
                            'email_body_md', v_pkg.email_body_md, 'valid_until', v_pkg.valid_until);
end $$;
revoke all on function public.prepare_quote_resend(uuid, uuid, uuid, uuid, text, text, text) from public, anon;
grant execute on function public.prepare_quote_resend(uuid, uuid, uuid, uuid, text, text, text) to authenticated;

-- 6. revoke_quote_links ---------------------------------------------------------------------
-- Revoca todos los enlaces activos de la cotización. Devuelve cuántos revocó.
create function public.revoke_quote_links(p_quote_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
  q        public.quotes;
  v_count  integer;
begin
  if v_tenant is null or v_uid is null or not app.has_role('owner', 'admin', 'sales') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_quote_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  -- El mismo candado de fila que usa la respuesta del cliente: aceptar y revocar a la vez no se cruzan.
  select * into q from public.quotes where tenant_id = v_tenant and id = p_quote_id for update;
  if not found then
    raise exception 'quote_not_found' using errcode = 'CP404';
  end if;
  if q.created_by <> v_uid and not app.has_role('owner', 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.share_links
     set revoked_at = now(), revoked_by = v_uid, revoke_reason = 'manual'
   where tenant_id = v_tenant and quote_id = q.id and activated_at is not null and revoked_at is null;
  get diagnostics v_count = row_count;
  if v_count > 0 then
    perform app.write_quote_event(v_tenant, q.id, 'link_revoked', 'user', v_uid,
      jsonb_build_object('count', v_count));
    perform app.write_audit(v_tenant, 'user', v_uid, 'share_link.revoked', 'quote', q.id, 'success',
      jsonb_build_object('count', v_count));
  end if;
  return v_count;
end $$;
revoke all on function public.revoke_quote_links(uuid) from public, anon;
grant execute on function public.revoke_quote_links(uuid) to authenticated;
