-- Migración 24 — Funciones del enlace del cliente, solo para el servidor (sprint 3, M23)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261006130000_share_public_rpcs.down.sql
-- Especificación: docs/arquitectura/sprint-3-envio-y-enlace.md §1 (M23) y §2; decisión 017.
--
-- Las ejecuta SOLO el servidor de la aplicación con la llave maestra (`service_role`), después de
-- validar el formato del token y los límites de tasa (el "portero", src/lib/share/gateway.ts). Ni
-- `anon` ni `authenticated` pueden llamarlas. Cada una recibe el sello (sha256) del token y actúa
-- solo sobre la fila de ese enlace: la organización sale de la fila, nunca de un argumento.
--
-- Códigos de error propios: CP422 dato inválido. Los resultados esperables (vencida, revocada, ya
-- respondida...) NO son errores: se devuelven en `result` / `state` para que la pantalla los explique.
--
-- Desviaciones del plan, justificadas:
--  * El texto de "otro" llega cifrado, así que la base no puede contar sus caracteres: acota el largo del
--    texto cifrado (equivale a 3–200 caracteres) y la aplicación valida el texto real antes de cifrar.
--  * La IP de una apertura se sella con el id del ENLACE (el id de la apertura es un número que la
--    aplicación no conoce antes de insertar): `share_link_views.ip|tenant|share_link_id`.

-- 0. Ayudas internas --------------------------------------------------------------------------
-- Pasa a "Vencida" una cotización enviada o vista (con la historia y sin datos personales). Idempotente.
create function app.expire_quote(p_tenant uuid, p_quote_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  update public.quotes set status = 'expired'
   where tenant_id = p_tenant and id = p_quote_id and status in ('sent', 'viewed')
  returning id into v_id;
  if v_id is null then
    return false;
  end if;
  perform app.write_quote_event(p_tenant, p_quote_id, 'expired', 'system', null, '{}'::jsonb);
  return true;
end $$;
revoke all on function app.expire_quote(uuid, uuid) from public, anon, authenticated;

-- Navegador recortado a 120 caracteres y sin caracteres de control.
create function app.short_user_agent(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(left(btrim(regexp_replace(coalesce(p, ''), '[\x01-\x1f\x7f]', '', 'g')), 120), '')
$$;
revoke all on function app.short_user_agent(text) from public, anon, authenticated;

-- 1. share_link_read ---------------------------------------------------------------------------
-- SOLO LEE (salvo que la fecha de vigencia ya pasó: entonces la cotización vence ahí mismo).
-- state: ok | expired | revoked | superseded | responded | not_found.
-- Con `expired`, `revoked` y `superseded` devuelve solo el contacto de la organización (no la cotización).
create function public.share_link_read(p_token_sha256 text) returns jsonb
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

-- 2. share_link_record_view --------------------------------------------------------------------
-- Suma una apertura. La primera vez, la cotización pasa de "Enviada" a "Vista" y queda un único evento.
create function public.share_link_record_view(p_token_sha256 text, p_ip_enc text, p_user_agent text)
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

-- 3. share_link_respond ------------------------------------------------------------------------
-- El cliente acepta o rechaza. Todo en una sola operación, bloqueando la cotización; la primera
-- respuesta gana y nunca se cambia. result: ok | already_responded | revoked | superseded | expired |
-- not_allowed | not_found.
create function public.share_link_respond(
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
