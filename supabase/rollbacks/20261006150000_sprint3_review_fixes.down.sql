-- Deshace 20261006150000_sprint3_review_fixes.sql
-- Vuelve a las funciones de las migraciones 21 a 25 tal como estaban. Se niega a correr si ya hay
-- paquetes: la columna quote_revision se perdería y los envíos quedarían sin su amarre a la revisión.
do $$
begin
  if exists (select 1 from public.quote_packages) then
    raise exception 'no se puede deshacer la migracion 26: hay paquetes de envio (registro legal)';
  end if;
end $$;

drop trigger if exists share_links_no_activate_revoked on public.share_links;
drop function if exists app.share_links_no_activate_revoked();
drop trigger if exists quote_packages_set_revision on public.quote_packages;
drop function if exists app.quote_packages_set_revision();
alter table public.quote_packages
  drop constraint if exists quote_packages_quote_revision_positive,
  drop column if exists quote_revision;

create or replace function app.quotes_send_lock_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.send_lock_until is not null and old.send_lock_until > now()
     and new.revision is distinct from old.revision then
    raise exception 'quote is being sent' using errcode = 'CP423';
  end if;
  return new;
end $$;

create or replace function app.expire_due_quotes() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c_batch constant integer := 1000;
  v_today date := app.current_business_date();
  v_count integer := 0;
  r record;
begin
  for r in
    select q.tenant_id, q.id
      from public.quotes q
     where q.status in ('sent', 'viewed') and q.valid_until is not null and q.valid_until < v_today
     order by q.valid_until, q.id
     limit c_batch
       for update skip locked
  loop
    if app.expire_quote(r.tenant_id, r.id) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;
revoke all on function app.expire_due_quotes() from public, anon, authenticated;

create or replace function public.share_link_read(p_token_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  l         public.share_links;
  q         public.quotes;
  p         public.quote_packages;
  v_resp    public.quote_responses;
  v_today   date := app.current_business_date();
  v_state   text;
  v_contact jsonb;
  v_base    jsonb;
begin
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('state', 'not_found');
  end if;
  select * into l from public.share_links where token_sha256 = p_token_sha256;
  if not found or l.activated_at is null then
    return jsonb_build_object('state', 'not_found');   -- un enlace que nunca salió no existe para nadie
  end if;

  select * into q from public.quotes where tenant_id = l.tenant_id and id = l.quote_id;
  select * into p from public.quote_packages where tenant_id = l.tenant_id and id = l.package_id;
  select * into v_resp from public.quote_responses where tenant_id = l.tenant_id and quote_id = l.quote_id;

  -- Vence por fecha aunque la tarea programada todavía no haya corrido.
  if q.status in ('sent', 'viewed') and q.valid_until is not null and q.valid_until < v_today then
    perform 1 from public.quotes where tenant_id = q.tenant_id and id = q.id for update;
    perform app.expire_quote(q.tenant_id, q.id);
    select * into q from public.quotes where tenant_id = l.tenant_id and id = l.quote_id;
  end if;

  v_contact := jsonb_build_object(
    'name', coalesce(p.document_snapshot #>> '{organization,name}',
                     (select t.name from public.tenants t where t.tenant_id = l.tenant_id)),
    'detail_lines', coalesce(p.document_snapshot #> '{organization,detailLines}', '[]'::jsonb));

  v_state := case
    when l.revoked_at is not null then 'revoked'
    when q.status = 'superseded' or q.current_package_id is distinct from l.package_id then 'superseded'
    when v_resp.id is not null then 'responded'
    when q.status = 'expired' then 'expired'
    when q.status in ('sent', 'viewed') then 'ok'
    else 'not_found'
  end;

  v_base := jsonb_build_object('state', v_state, 'org_contact', v_contact);
  if v_state in ('expired', 'revoked', 'superseded', 'not_found') then
    return v_base;
  end if;

  return v_base || jsonb_build_object(
    'tenant_id', l.tenant_id,
    'quote_id', l.quote_id,
    'package_id', l.package_id,
    'share_link_id', l.id,
    'quote_status', q.status,
    'valid_until', q.valid_until,
    'response', case when v_resp.id is null then null
                     else jsonb_build_object('decision', v_resp.decision, 'responded_at', v_resp.responded_at,
                                             'reason_code', v_resp.reason_code) end,
    'document_snapshot', p.document_snapshot,
    'customer_snapshot_enc', p.customer_snapshot_enc,
    'pdf_path', p.pdf_path,
    'pdf_sha256', p.pdf_sha256,
    'logo_path', p.logo_path);
end $$;
revoke all on function public.share_link_read(text) from public, anon, authenticated;
grant execute on function public.share_link_read(text) to service_role;

create or replace function public.share_link_record_view(p_token_sha256 text, p_ip_enc text, p_user_agent text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  l       public.share_links;
  q       public.quotes;
  v_first boolean := false;
begin
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$'
     or (p_ip_enc is not null and char_length(p_ip_enc) > 2000) then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into l from public.share_links where token_sha256 = p_token_sha256;
  if not found or l.activated_at is null or l.revoked_at is not null then
    return jsonb_build_object('recorded', false);
  end if;

  -- El mismo candado de fila que usa la respuesta: abrir y responder a la vez no se cruzan.
  select * into q from public.quotes where tenant_id = l.tenant_id and id = l.quote_id for update;
  if q.current_package_id is distinct from l.package_id
     or q.status not in ('sent', 'viewed', 'accepted', 'rejected_by_customer') then
    return jsonb_build_object('recorded', false);
  end if;
  if q.status in ('sent', 'viewed') and q.valid_until is not null and q.valid_until < app.current_business_date() then
    return jsonb_build_object('recorded', false);   -- vencida: no cuenta como apertura
  end if;

  insert into public.share_link_views (tenant_id, share_link_id, ip_enc, user_agent_short)
  values (l.tenant_id, l.id, p_ip_enc, app.short_user_agent(p_user_agent));
  update public.share_links
     set view_count = view_count + 1, last_viewed_at = now(), first_viewed_at = coalesce(first_viewed_at, now())
   where tenant_id = l.tenant_id and id = l.id
  returning (view_count = 1) into v_first;

  if q.first_viewed_at is null then
    update public.quotes
       set first_viewed_at = now(), status = case when status = 'sent' then 'viewed' else status end
     where tenant_id = q.tenant_id and id = q.id;
    perform app.write_quote_event(q.tenant_id, q.id, 'viewed', 'public', null,
      jsonb_build_object('share_link_id', l.id));
  end if;
  return jsonb_build_object('recorded', true, 'first', coalesce(v_first, false));
end $$;
revoke all on function public.share_link_record_view(text, text, text) from public, anon, authenticated;
grant execute on function public.share_link_record_view(text, text, text) to service_role;

create or replace function public.share_link_respond(
  p_token_sha256 text, p_response_id uuid, p_response_key uuid, p_decision text,
  p_acceptor_name_enc text, p_reason_code text, p_reason_text_enc text, p_ip_enc text,
  p_origin_ip inet, p_user_agent text, p_acceptance_text_version text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  -- Texto de "otro", cifrado: 3 a 200 caracteres equivalen a ~46 a ~1.100 caracteres cifrados.
  c_reason_enc_min constant integer := 46;
  c_reason_enc_max constant integer := 1200;
  c_reasons constant text[] := array['price_too_high', 'not_in_budget', 'chose_other_provider', 'timing',
                                     'no_longer_needed', 'other'];
  l       public.share_links;
  q       public.quotes;
  p       public.quote_packages;
  v_resp  public.quote_responses;
  v_new   text;
  v_now   timestamptz := now();
begin
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' or p_response_id is null
     or p_response_key is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;

  -- (1) El enlace, y la cotización bloqueada.
  select * into l from public.share_links where token_sha256 = p_token_sha256;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  select * into q from public.quotes where tenant_id = l.tenant_id and id = l.quote_id for update;
  select * into p from public.quote_packages where tenant_id = l.tenant_id and id = l.package_id;

  -- (2) El mismo clic repetido: el mismo resultado, sin hacer nada más.
  select * into v_resp from public.quote_responses
   where share_link_id = l.id and response_key = p_response_key;
  if found then
    return jsonb_build_object('result', 'ok', 'replayed', true, 'decision', v_resp.decision,
                              'response_id', v_resp.id, 'responded_at', v_resp.responded_at);
  end if;
  -- (3) Ya hay otra respuesta: se informa cuál quedó, sin cambiarla.
  select * into v_resp from public.quote_responses where tenant_id = l.tenant_id and quote_id = l.quote_id;
  if found then
    return jsonb_build_object('result', 'already_responded', 'decision', v_resp.decision,
                              'responded_at', v_resp.responded_at);
  end if;

  -- (4) Revocado, o nunca activado.
  if l.activated_at is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if l.revoked_at is not null then
    return jsonb_build_object('result', 'revoked');
  end if;
  -- (5) Una versión más nueva reemplazó a esta.
  if q.status = 'superseded' or q.current_package_id is distinct from l.package_id then
    return jsonb_build_object('result', 'superseded');
  end if;
  -- (6) Vigencia: vale hasta el último día inclusive.
  if q.status in ('sent', 'viewed') and q.valid_until is not null and q.valid_until < app.current_business_date() then
    perform app.expire_quote(q.tenant_id, q.id);
    return jsonb_build_object('result', 'expired');
  end if;
  if q.status = 'expired' then
    return jsonb_build_object('result', 'expired');
  end if;
  if q.status not in ('sent', 'viewed') then
    return jsonb_build_object('result', 'not_allowed');
  end if;

  -- (7) Se revalida todo, aunque la aplicación ya lo hizo.
  if p_decision is null or p_decision not in ('accepted', 'rejected')
     or (p_ip_enc is not null and char_length(p_ip_enc) > 2000) then
    raise exception 'invalid_decision' using errcode = 'CP422';
  end if;
  if p_decision = 'accepted' then
    if p_acceptor_name_enc is null or char_length(p_acceptor_name_enc) not between 1 and 2000
       or p_acceptance_text_version is null or char_length(p_acceptance_text_version) not between 1 and 40
       or p_reason_code is not null or p_reason_text_enc is not null then
      raise exception 'invalid_acceptance' using errcode = 'CP422';
    end if;
  else
    if p_reason_code is null or p_reason_code <> all (c_reasons) or p_acceptor_name_enc is not null then
      raise exception 'invalid_rejection' using errcode = 'CP422';
    end if;
    if p_reason_code = 'other' then
      if p_reason_text_enc is null or char_length(p_reason_text_enc) not between c_reason_enc_min and c_reason_enc_max then
        raise exception 'invalid_reason_text' using errcode = 'CP422';
      end if;
    elsif p_reason_text_enc is not null then
      raise exception 'invalid_reason_text' using errcode = 'CP422';
    end if;
  end if;

  -- (8) Cambio de estado: solo desde Enviada o Vista.
  v_new := case p_decision when 'accepted' then 'accepted' else 'rejected_by_customer' end;
  update public.quotes set status = v_new, responded_at = v_now
   where tenant_id = q.tenant_id and id = q.id and status in ('sent', 'viewed');
  if not found then
    return jsonb_build_object('result', 'not_allowed');
  end if;

  -- (9) El registro de conformidad, con el sello del contenido que se aceptó.
  insert into public.quote_responses
    (id, tenant_id, quote_id, package_id, share_link_id, decision, response_key, acceptor_name_enc,
     reason_code, reason_text_enc, package_content_sha256, acceptance_text_version, ip_enc,
     user_agent_short, responded_at)
  values
    (p_response_id, l.tenant_id, l.quote_id, l.package_id, l.id, p_decision, p_response_key,
     p_acceptor_name_enc, p_reason_code, p_reason_text_enc, p.content_sha256, p_acceptance_text_version,
     p_ip_enc, app.short_user_agent(p_user_agent), v_now);

  -- (10) Línea de tiempo y auditoría, con la IP real y sin nombre, texto ni correo.
  perform app.write_quote_event(l.tenant_id, l.quote_id, v_new, 'public', null,
    case when p_decision = 'rejected' then jsonb_build_object('reason_code', p_reason_code) else '{}'::jsonb end);
  perform app.write_audit(l.tenant_id, 'public', null,
    case p_decision when 'accepted' then 'quote.accepted' else 'quote.rejected' end,
    'quote', l.quote_id, 'success',
    jsonb_build_object('package_id', l.package_id, 'share_link_id', l.id)
      || case when p_decision = 'rejected' then jsonb_build_object('reason_code', p_reason_code) else '{}'::jsonb end,
    p_origin_ip);

  return jsonb_build_object('result', 'ok', 'replayed', false, 'decision', p_decision,
                            'response_id', p_response_id, 'responded_at', v_now,
                            'tenant_id', l.tenant_id, 'quote_id', l.quote_id,
                            'author_id', q.created_by, 'number_display', q.number_display);
end $$;
revoke all on function public.share_link_respond(text, uuid, uuid, text, text, text, text, text, inet, text, text)
  from public, anon, authenticated;
grant execute on function public.share_link_respond(text, uuid, uuid, text, text, text, text, text, inet, text, text)
  to service_role;

drop function if exists public.attach_quote_package_document(uuid, text, text, integer, text, jsonb, text, text);
drop function if exists public.confirm_email_dispatch(uuid, text, text, text);
drop function if exists public.fail_email_dispatch(uuid, text, text);

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
