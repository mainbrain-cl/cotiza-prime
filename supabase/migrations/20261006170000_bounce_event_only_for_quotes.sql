-- Migración 28 — El rebote de un aviso interno no entra en la historia de la cotización
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261006170000_bounce_event_only_for_quotes.down.sql
-- Corrige: `record_email_event` escribía «El correo rebotó: no llegó al cliente» en la línea de tiempo
-- también para los avisos internos (`internal_notice`, que desde la migración 27 se registran en
-- email_messages). Ese evento habla del correo AL CLIENTE: ahora solo se escribe para `quote` y
-- `quote_resend`. El rebote de un aviso interno queda solo en email_messages (estado y tipo de rebote).
-- Es la misma función de la migración 25 con una sola condición nueva; los permisos se conservan.

create or replace function public.record_email_event(
  p_provider text, p_provider_message_id text, p_event text, p_occurred_at timestamptz, p_bounce_type text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_mail     public.email_messages;
  v_at       timestamptz := coalesce(p_occurred_at, now());
  v_rank_now integer;
  v_rank_new integer;
  v_last     timestamptz;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,30}$' or p_provider_message_id is null
     or char_length(p_provider_message_id) not between 1 and 200
     or p_event is null or p_event not in ('delivered', 'bounced', 'complained') then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if p_event = 'bounced' and (p_bounce_type is null or p_bounce_type not in ('hard', 'soft')) then
    raise exception 'invalid_bounce_type' using errcode = 'CP422';
  end if;

  select * into v_mail from public.email_messages
   where provider = p_provider and provider_message_id = p_provider_message_id for update;
  if not found then
    return jsonb_build_object('result', 'unknown');
  end if;

  v_rank_now := case v_mail.status when 'sent' then 1 when 'delivered' then 2
                  when 'bounced' then 3 when 'complained' then 3 else 9 end;
  v_rank_new := case p_event when 'delivered' then 2 else 3 end;
  -- Un correo que nunca salió (pending o failed), o que ya llegó a su estado final, no cambia.
  if v_rank_now = 9 or v_rank_now = 0 or v_rank_new <= v_rank_now then
    return jsonb_build_object('result', 'ignored', 'status', v_mail.status);
  end if;
  -- Aviso más viejo que el último aviso del proveedor ya aplicado: se ignora.
  v_last := greatest(v_mail.delivered_at, v_mail.bounced_at);
  if v_last is not null and v_at < v_last then
    return jsonb_build_object('result', 'ignored_older', 'status', v_mail.status);
  end if;

  if p_event = 'delivered' then
    update public.email_messages
       set status = 'delivered', delivered_at = v_at, status_at = greatest(status_at, v_at)
     where tenant_id = v_mail.tenant_id and id = v_mail.id;
  elsif p_event = 'bounced' then
    update public.email_messages
       set status = 'bounced', bounce_type = p_bounce_type, bounced_at = v_at, status_at = greatest(status_at, v_at)
     where tenant_id = v_mail.tenant_id and id = v_mail.id;
    -- La historia de la cotización solo cuenta los correos AL CLIENTE; el de un aviso interno no.
    if v_mail.kind in ('quote', 'quote_resend') then
      perform app.write_quote_event(v_mail.tenant_id, v_mail.quote_id, 'email_bounced', 'system', null,
        jsonb_build_object('email_message_id', v_mail.id, 'bounce_type', p_bounce_type));
    end if;
  else
    update public.email_messages
       set status = 'complained', status_at = greatest(status_at, v_at)
     where tenant_id = v_mail.tenant_id and id = v_mail.id;
  end if;
  return jsonb_build_object('result', 'applied', 'status',
    case p_event when 'delivered' then 'delivered' when 'bounced' then 'bounced' else 'complained' end);
end $$;
