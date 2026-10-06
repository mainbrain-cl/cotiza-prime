-- Deshace 20261006120000_quote_send_rpcs.sql
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
