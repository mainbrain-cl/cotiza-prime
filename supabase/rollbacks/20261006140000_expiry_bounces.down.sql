-- Deshace 20261006140000_expiry_bounces.sql
drop function if exists public.record_email_event(text, text, text, timestamptz, text);

-- Cancela la tarea programada. La extensión pg_cron se deja instalada: es del proveedor y otras
-- tareas podrían usarla; la migración solo la activa con `create extension if not exists`.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'expire-quotes';
  end if;
end $$;

drop function if exists app.expire_due_quotes();
