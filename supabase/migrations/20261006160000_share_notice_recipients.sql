-- Migración 27 — Destinatarios y registro del aviso interno de respuesta del cliente (sprint 3, H-031)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261006160000_share_notice_recipients.down.sql
-- Corrige los hallazgos B-1 e I-4 de la revisión de H-031 (docs/arquitectura/sprint-3-envio-y-enlace.md §13).
--
-- B-1: el aviso de «aceptada / rechazada» solo puede ir a quien hoy pertenece a la organización. La base
--      decide el destino: el autor de la cotización si sigue como miembro activo; si no, el Dueño y los
--      Administradores activos. Los correos de las cuentas viven en auth.users (sin cifrar, como los
--      guarda Supabase Auth); la función los entrega ya filtrados, así el portero no necesita la API de
--      cuentas del servidor.
-- I-4: cada aviso queda registrado en email_messages (kind internal_notice, con package_id y sin enlace).
--
-- La organización NUNCA es un parámetro (guardia G4): sale de la fila de la respuesta o del correo.
-- Las tres funciones las ejecuta solo el servidor (service_role). Ninguna lee ni devuelve el nombre ni el
-- texto libre del cliente.

-- 1. Destinatarios --------------------------------------------------------------------------------
create function public.share_notice_recipients(p_quote_id uuid, p_response_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r             public.quote_responses;
  q             public.quotes;
  v_author_ok   boolean;
  v_audience    text;
  v_recipients  jsonb;
begin
  if p_quote_id is null or p_response_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  -- La respuesta tiene que existir y ser de ESA cotización; la organización sale de su fila.
  select * into r from public.quote_responses where id = p_response_id and quote_id = p_quote_id;
  if not found then
    raise exception 'response_not_found' using errcode = 'CP404';
  end if;
  select * into q from public.quotes where tenant_id = r.tenant_id and id = r.quote_id;

  select exists (
    select 1 from public.members m join auth.users u on u.id = m.user_id
     where m.tenant_id = r.tenant_id and m.user_id = q.created_by and m.status = 'active'
       and u.email is not null
  ) into v_author_ok;
  v_audience := case when v_author_ok then 'author' else 'managers' end;

  select coalesce(jsonb_agg(jsonb_build_object('user_id', x.user_id, 'email', x.email) order by x.email),
                  '[]'::jsonb)
    into v_recipients
    from (
      select u.id as user_id, u.email::text as email
        from public.members m join auth.users u on u.id = m.user_id
       where m.tenant_id = r.tenant_id and m.status = 'active' and u.email is not null
         and ((v_author_ok and m.user_id = q.created_by)
              or (not v_author_ok and m.role in ('owner', 'admin')))
    ) x;

  return jsonb_build_object('package_id', r.package_id, 'audience', v_audience, 'recipients', v_recipients);
end $$;
revoke all on function public.share_notice_recipients(uuid, uuid) from public, anon, authenticated;
grant execute on function public.share_notice_recipients(uuid, uuid) to service_role;

-- 2. Registrar el aviso (antes de enviarlo) --------------------------------------------------------
create function public.internal_notice_register(
  p_email_id uuid, p_quote_id uuid, p_response_id uuid, p_to_user_id uuid,
  p_to_email_enc text, p_to_email_hash text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.quote_responses;
begin
  if p_email_id is null or p_quote_id is null or p_response_id is null
     or p_to_user_id is null or p_to_email_enc is null or char_length(p_to_email_enc) not between 1 and 2000
     or p_to_email_hash is null or p_to_email_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into r from public.quote_responses where id = p_response_id and quote_id = p_quote_id;
  if not found then
    raise exception 'response_not_found' using errcode = 'CP404';
  end if;
  -- El destinatario tiene que seguir siendo miembro activo de esa organización.
  if not exists (select 1 from public.members m
                  where m.tenant_id = r.tenant_id and m.user_id = p_to_user_id and m.status = 'active') then
    raise exception 'recipient_not_member' using errcode = '42501';
  end if;
  insert into public.email_messages
    (id, tenant_id, quote_id, package_id, share_link_id, kind, to_email_enc, to_email_hash, provider, status)
  values
    (p_email_id, r.tenant_id, r.quote_id, r.package_id, null, 'internal_notice', p_to_email_enc,
     p_to_email_hash, 'pending', 'pending')
  on conflict (id) do nothing;
  return jsonb_build_object('registered', true);
end $$;
revoke all on function public.internal_notice_register(uuid, uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.internal_notice_register(uuid, uuid, uuid, uuid, text, text)
  to service_role;

-- 3. Cerrar el aviso: enviado o fallido ------------------------------------------------------------
create function public.internal_notice_settle(
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
   where id = p_email_id and kind = 'internal_notice' for update;
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
revoke all on function public.internal_notice_settle(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.internal_notice_settle(uuid, text, text, text) to service_role;
