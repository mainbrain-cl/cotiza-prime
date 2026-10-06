-- Deshace 20261006130000_share_public_rpcs.sql
-- Protección del registro legal: sin estas funciones el cliente no podría ver ni responder su cotización;
-- si ya hay envíos, respuestas o cotizaciones enviadas, no se deshace.
do $$
begin
  if exists (select 1 from public.quote_packages)
     or exists (select 1 from public.email_messages)
     or exists (select 1 from public.share_links)
     or exists (select 1 from public.quote_responses)
     or exists (select 1 from public.quotes
                 where status in ('sent', 'viewed', 'accepted', 'rejected_by_customer', 'expired')) then
    raise exception 'no se puede deshacer: hay registros de envio o respuestas del cliente (registro legal)';
  end if;
end $$;

drop function if exists public.share_link_respond(text, uuid, uuid, text, text, text, text, text, inet, text, text);
drop function if exists public.share_link_record_view(text, text, text);
drop function if exists public.share_link_read(text);
drop function if exists app.short_user_agent(text);
drop function if exists app.expire_quote(uuid, uuid);
