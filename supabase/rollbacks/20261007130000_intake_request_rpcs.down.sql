-- Deshace 20261007130000_intake_request_rpcs.sql
-- Protección: no se deshace si ya hay solicitudes (sin estas funciones no se pueden asignar ni convertir) o
-- cotizaciones que nacieron de una solicitud (se perdería el vínculo «Solicitud original»).
do $$
begin
  if exists (select 1 from public.intake_requests)
     or exists (select 1 from public.quotes where source_request_id is not null) then
    raise exception 'no se puede deshacer: hay solicitudes del formulario publico o cotizaciones nacidas de una solicitud';
  end if;
end $$;

drop function if exists public.convert_intake_request(uuid, uuid, uuid);
drop function if exists public.restore_intake_request(uuid);
drop function if exists public.discard_intake_request(uuid, text, text);
drop function if exists public.assign_intake_request(uuid, uuid);

drop index if exists public.quotes_source_request;
alter table public.quotes
  drop constraint if exists quotes_tenant_id_source_request_id_fkey,
  drop column if exists source_request_id;
