-- Deshace 20261007120000_intake_public_rpcs.sql
-- Protección: sin estas funciones el formulario público no podría recibir ni avisar solicitudes. Si ya hay
-- solicitudes, contadores o avisos de solicitud, no se deshace (se perdería lo que alguien pidió).
do $$
begin
  if exists (select 1 from public.intake_requests)
     or exists (select 1 from public.intake_daily_counters)
     or exists (select 1 from public.email_messages
                 where kind in ('request_assigned', 'request_received', 'intake_cap_reached')) then
    raise exception 'no se puede deshacer: hay solicitudes del formulario publico, contadores o avisos de solicitud';
  end if;
end $$;

drop function if exists public.intake_notice_settle(uuid, text, text, text);
drop function if exists public.intake_notice_register(uuid, uuid, text, uuid, text, text, uuid);
drop function if exists public.intake_notice_recipients(uuid, text, uuid);
drop function if exists public.intake_record_block(text, text);
drop function if exists public.intake_request_submit(text, uuid, uuid, integer, text, text, text, text, text, text, text, text, date, jsonb, text, text, text);
drop function if exists public.intake_form_read(text);
drop function if exists app.intake_managers(uuid);
drop function if exists app.intake_count(uuid, uuid, text);
drop function if exists app.business_date_of(timestamptz);
drop function if exists app.intake_request_notices_per_day();
drop function if exists app.intake_org_daily_cap();
