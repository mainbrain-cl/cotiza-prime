-- Deshace 20261006120000_quote_send_rpcs.sql
-- Protección del registro legal: sin estas funciones nadie podría completar ni corregir un envío; si ya
-- hay envíos, respuestas del cliente o cotizaciones enviadas, no se deshace.
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

drop function if exists public.revoke_quote_links(uuid);
drop function if exists public.prepare_quote_resend(uuid, uuid, uuid, uuid, text, text, text);
drop function if exists public.fail_email_dispatch(uuid, text);
drop function if exists public.confirm_email_dispatch(uuid, text, text);
drop function if exists public.attach_quote_package_document(uuid, text, text, integer, text, jsonb, text);
drop function if exists public.prepare_quote_send(uuid, integer, uuid, uuid, uuid, uuid, text, text, text, text, text, text);
drop function if exists app.abandon_package(uuid, uuid);
drop function if exists app.write_quote_event(uuid, uuid, text, text, uuid, jsonb);
drop function if exists app.write_audit(uuid, text, uuid, text, text, uuid, text, jsonb, inet);
drop function if exists app.resend_max_total();
drop function if exists app.resend_max_per_day();
drop function if exists app.send_lock_seconds();
