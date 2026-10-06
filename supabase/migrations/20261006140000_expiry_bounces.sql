-- Migración 25 — Vencimiento programado y avisos del proveedor de correo (sprint 3, M24)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261006140000_expiry_bounces.down.sql
-- Especificación: docs/arquitectura/sprint-3-envio-y-enlace.md §1 (M24) y §4.
--
-- pg_cron: en la Supabase local (imagen con pg_cron 1.6.4) ya viene cargada (`shared_preload_libraries`)
-- y trabaja sobre la base `postgres`, así que basta `create extension`; no hace falta tocar
-- supabase/config.toml. En el proyecto de Supabase en la nube se activa igual (es una extensión del
-- proveedor). Si en algún entorno no estuviera disponible, esta migración NO falla: deja la función
-- app.expire_due_quotes() y avisa. La alternativa es llamarla cada hora desde un trabajo programado del
-- servidor (p. ej. la programación de Vercel) con la llave maestra; y, aun sin ella, una cotización
-- vencida nunca se acepta ni se muestra como vigente, porque el enlace del cliente comprueba la fecha
-- en cada lectura y cada respuesta (migración 24).
--
-- Desviación del plan: un aviso del proveedor se ignora como "más viejo" cuando es anterior al último
-- aviso del PROVEEDOR ya aplicado (entrega o rebote), no al `status_at` del envío: el correo se
-- confirma después de que el proveedor responde, así que una entrega muy rápida llegaría "antes".

-- 1. Vencimiento ---------------------------------------------------------------------------------
-- Pasa a "Vencida" las cotizaciones Enviadas o Vistas cuya vigencia ya terminó (vale hasta el último
-- día inclusive). Una cotización que el cliente está respondiendo en este instante (fila bloqueada) se
-- salta y se toma en la corrida siguiente. Devuelve cuántas venció.
create function app.expire_due_quotes() returns integer
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

-- Programación cada hora, al minuto 5.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('expire-quotes', '5 * * * *', 'select app.expire_due_quotes()');
  else
    raise notice 'pg_cron no está disponible: llamar app.expire_due_quotes() cada hora desde un trabajo del servidor';
  end if;
end $$;

-- 2. Avisos del proveedor de correo -------------------------------------------------------------
-- Idempotente: repetir un aviso no cambia nada; el estado avanza (enviado < entregado < rebotado o
-- reclamado) y nunca retrocede; un aviso más viejo que el último aplicado se ignora. Solo el servidor
-- (la ruta de avisos, después de verificar la firma del proveedor) la ejecuta.
-- result: applied | ignored | ignored_older | unknown.
create function public.record_email_event(
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
    perform app.write_quote_event(v_mail.tenant_id, v_mail.quote_id, 'email_bounced', 'system', null,
      jsonb_build_object('email_message_id', v_mail.id, 'bounce_type', p_bounce_type));
  else
    update public.email_messages
       set status = 'complained', status_at = greatest(status_at, v_at)
     where tenant_id = v_mail.tenant_id and id = v_mail.id;
  end if;
  return jsonb_build_object('result', 'applied', 'status',
    case p_event when 'delivered' then 'delivered' when 'bounced' then 'bounced' else 'complained' end);
end $$;
revoke all on function public.record_email_event(text, text, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.record_email_event(text, text, text, timestamptz, text) to service_role;
