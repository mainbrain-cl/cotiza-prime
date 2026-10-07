-- Migración 33 — Limpieza por plazo de las solicitudes del formulario público (sprint 4, M33)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261007140000_intake_retention.down.sql
-- Especificación: docs/arquitectura/sprint-4-formulario-publico.md §1 (M33); PROYECTO.md §11.2; Ley 21.719.
--
-- Nada se guarda indefinidamente (LEGAL.md §1.3). Una vez al día, app.purge_intake_data():
--   * borra las solicitudes nuevas o asignadas de más de 12 meses (nunca se concretaron);
--   * borra las descartadas de más de 30 días;
--   * en las convertidas de más de 12 meses VACÍA los datos de contacto y marca `anonymized_at` (conserva los
--     servicios pedidos, las fechas y el vínculo con la cotización, que son historia de la organización);
--   * borra los contadores de más de 90 días;
--   * borra, junto con cada solicitud vencida, sus avisos por correo (no llevan datos del visitante, pero
--     apuntan a la solicitud).
-- Igual que `audit_log` y las aperturas del enlace: solo lo hace esta función, fijando
-- app.retention_purge = 'on' dentro de su transacción; las guardas de solo agregar de las tablas dejan
-- pasar únicamente lo vencido. Los plazos son las constantes de la migración 30.
--
-- pg_cron: igual que la migración 25. Si no estuviera disponible en algún entorno, NO falla: deja la
-- función y avisa; la alternativa es llamarla cada día desde un trabajo programado del servidor.

create function app.purge_intake_data() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_previous     text := current_setting('app.retention_purge', true);
  v_notices      integer;
  v_requests     integer;
  v_anonymized   integer;
  v_counters     integer;
  v_unconverted_cutoff timestamptz := now() - make_interval(months => app.intake_unconverted_retention_months());
  v_discarded_cutoff   timestamptz := now() - make_interval(days => app.intake_discarded_retention_days());
  v_anonymize_cutoff   timestamptz := now() - make_interval(months => app.intake_converted_anonymize_months());
begin
  perform set_config('app.retention_purge', 'on', true);

  -- Los avisos de las solicitudes que se van a borrar (la solicitud es lo que los ata).
  delete from public.email_messages e
   using public.intake_requests r
   where e.tenant_id = r.tenant_id and e.intake_request_id = r.id
     and e.kind in ('request_assigned', 'request_received')
     and ((r.status in ('new', 'assigned') and r.created_at <= v_unconverted_cutoff)
          or (r.status = 'discarded' and r.discarded_at <= v_discarded_cutoff));
  get diagnostics v_notices = row_count;

  delete from public.intake_requests r
   where (r.status in ('new', 'assigned') and r.created_at <= v_unconverted_cutoff)
      or (r.status = 'discarded' and r.discarded_at <= v_discarded_cutoff);
  get diagnostics v_requests = row_count;

  update public.intake_requests
     set contact_name_enc = null, contact_email_enc = null, contact_phone_enc = null, company_enc = null,
         comuna_enc = null, service_address_enc = null, message_enc = null, contact_email_hash = null,
         consent_ip_enc = null, anonymized_at = now()
   where status = 'converted' and anonymized_at is null and created_at <= v_anonymize_cutoff;
  get diagnostics v_anonymized = row_count;

  delete from public.intake_daily_counters
   where day < app.business_date_of(now()) - app.intake_counters_retention_days();
  get diagnostics v_counters = row_count;

  -- Se deja el interruptor como estaba (la transacción de quien llama puede seguir).
  perform set_config('app.retention_purge', coalesce(v_previous, ''), true);
  return jsonb_build_object('requests_deleted', v_requests, 'notices_deleted', v_notices,
                            'requests_anonymized', v_anonymized, 'counters_deleted', v_counters);
end $$;
-- Solo la ejecuta la tarea programada (como dueño de la base) o un trabajo del servidor con permiso expreso.
revoke all on function app.purge_intake_data() from public, anon, authenticated;

-- Programación diaria, a las 03:30.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('purge-intake-data', '30 3 * * *', 'select app.purge_intake_data()');
  else
    raise notice 'pg_cron no está disponible: llamar app.purge_intake_data() cada día desde un trabajo del servidor';
  end if;
end $$;
