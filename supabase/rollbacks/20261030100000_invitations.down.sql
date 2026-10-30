-- Deshace 20261030100000_invitations.sql
-- Protección de datos personales: no se deshace si ya hay invitaciones o correos de invitación (borrarlos
-- perdería a quién se invitó y con qué rol). Si hay datos, se cancelan y se borran a mano antes de deshacer.
do $$
begin
  if exists (select 1 from public.invitations)
     or exists (select 1 from public.email_messages where kind = 'invitation') then
    raise exception 'no se puede deshacer: hay invitaciones o correos de invitacion';
  end if;
end $$;

-- Tarea programada y funciones
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'purge-invitations';
  end if;
end $$;
drop function if exists app.purge_invitations();
drop function if exists public.invitation_email_settle(uuid, text, text, text);
drop function if exists public.revoke_invitation(uuid);
drop function if exists public.resend_invitation(uuid, text, text, uuid, text);
drop function if exists public.create_invitation(uuid, text, text, text, text, text, uuid, text);

-- email_messages vuelve a lo de antes: sin el tipo `invitation`, sin la columna y con la lectura abierta a
-- todos los miembros de la organización.
alter policy email_messages_select on public.email_messages
  using (tenant_id = (select app.current_tenant_id()));
drop index if exists public.email_messages_invitation;
alter table public.email_messages drop constraint email_messages_target_shape;
alter table public.email_messages
  drop constraint if exists email_messages_tenant_id_invitation_id_fkey,
  drop column if exists invitation_id;
alter table public.email_messages add constraint email_messages_target_shape check (
     (kind in ('quote', 'quote_resend', 'internal_notice', 'payment_1', 'payment_2')
      and quote_id is not null and package_id is not null
      and intake_request_id is null and intake_form_id is null)
  or (kind in ('request_assigned', 'request_received')
      and intake_request_id is not null
      and quote_id is null and package_id is null and intake_form_id is null)
  or (kind = 'intake_cap_reached'
      and intake_form_id is not null
      and quote_id is null and package_id is null and intake_request_id is null));
alter table public.email_messages drop constraint email_messages_kind_check;
alter table public.email_messages add constraint email_messages_kind_check
  check (kind in ('quote', 'quote_resend', 'internal_notice', 'payment_1', 'payment_2',
                  'request_assigned', 'request_received', 'intake_cap_reached'));

-- La guarda de solo agregar vuelve a la versión de la migración 34 (solo los avisos de solicitud vencida).
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

-- La tabla y lo que la acompaña
drop table public.invitations;
drop domain app.invitation_role;
drop function if exists app.invitation_binding(text, text);
drop function if exists app.normalize_email(text);
drop function if exists
  app.invitation_ttl_days(), app.invitation_max_per_user_hour(), app.invitation_max_per_tenant_day(),
  app.invitation_max_pending(), app.invitation_max_resends(), app.invitation_resend_min_minutes(),
  app.invitation_retention_days();
