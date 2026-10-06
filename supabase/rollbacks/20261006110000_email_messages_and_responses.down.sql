-- Deshace 20261006110000_email_messages_and_responses.sql
-- Protección del registro legal: no se deshace si ya hay correos, enlaces, aperturas o respuestas del
-- cliente (antes esta función los borraba). Si hay datos, se archivan a mano antes de deshacer.
do $$
begin
  if exists (select 1 from public.quote_responses)
     or exists (select 1 from public.email_messages)
     or exists (select 1 from public.share_links)
     or exists (select 1 from public.share_link_views) then
    raise exception 'no se puede deshacer: hay registros de envio o respuestas del cliente (registro legal)';
  end if;
end $$;

drop table if exists public.quote_responses;
alter table public.share_links drop constraint if exists share_links_email_message_fk;
drop table if exists public.email_messages;
drop function if exists app.email_messages_guard();
