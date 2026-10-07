-- Deshace 20261007140000_intake_retention.sql
-- Cancela la tarea programada y quita la función. Sin ella, las solicitudes dejarían de borrarse por plazo:
-- si ya hay solicitudes con datos de contacto, no se deshace (quedarían guardadas sin límite, contra la
-- política de conservación). La extensión pg_cron se deja instalada: es del proveedor y otras tareas
-- podrían usarla.
do $$
begin
  if exists (select 1 from public.intake_requests where anonymized_at is null) then
    raise exception 'no se puede deshacer: hay solicitudes con datos de contacto que se borran por plazo';
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'purge-intake-data';
  end if;
end $$;

drop function if exists app.purge_intake_data();
