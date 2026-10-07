-- Deshace 20261007110000_intake_requests.sql
-- Protección de datos personales de desconocidos: no se deshace si ya hay solicitudes o avisos de
-- solicitud (borrarlos perdería lo que alguien pidió). Si hay datos, se archivan a mano antes de deshacer.
do $$
begin
  if exists (select 1 from public.intake_requests)
     or exists (select 1 from public.email_messages
                 where kind in ('request_assigned', 'request_received', 'intake_cap_reached')) then
    raise exception 'no se puede deshacer: hay solicitudes del formulario publico o avisos de solicitud';
  end if;
end $$;

-- email_messages vuelve a exigir cotización y paquete en todo correo.
drop index if exists public.email_messages_intake_form;
drop index if exists public.email_messages_intake_request;
alter table public.email_messages
  drop constraint if exists email_messages_target_shape,
  drop constraint if exists email_messages_tenant_id_intake_form_id_fkey,
  drop constraint if exists email_messages_tenant_id_intake_request_id_fkey,
  drop column if exists intake_form_id,
  drop column if exists intake_request_id,
  alter column quote_id set not null,
  alter column package_id set not null;
alter table public.email_messages drop constraint email_messages_kind_check;
alter table public.email_messages add constraint email_messages_kind_check
  check (kind in ('quote', 'quote_resend', 'internal_notice', 'payment_1', 'payment_2'));

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

-- Quita los alcances nuevos del límite de intentos (y sus filas, para que la restricción vuelva a valer).
delete from public.auth_rate_limits
  where scope in ('intake_read_ip', 'intake_submit_ip', 'intake_submit_ip_day', 'intake_submit_form');
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant',
                   'share_ip', 'share_token', 'share_respond_ip', 'quote_send_user'));

drop table if exists public.intake_daily_counters;
drop table if exists public.intake_requests;
drop function if exists app.intake_requests_guard();
drop function if exists app.intake_items_valid(jsonb);
drop function if exists app.intake_request_item_valid(jsonb);
drop function if exists app.intake_request_items_max_bytes();
drop function if exists app.intake_request_items_max();
drop function if exists app.intake_counters_retention_days();
drop function if exists app.intake_converted_anonymize_months();
drop function if exists app.intake_discarded_retention_days();
drop function if exists app.intake_unconverted_retention_months();
