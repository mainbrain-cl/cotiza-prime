-- Deshace 20261006100000_quote_packages_and_links.sql
-- Protección del registro legal: no se deshace si ya hay envíos o cotizaciones enviadas. Borrarlos
-- dejaría cotizaciones «Enviada», «Vista» o «Aceptada» sin su paquete ni su enlace.
do $$
begin
  if exists (select 1 from public.quote_packages)
     or exists (select 1 from public.share_links)
     or exists (select 1 from public.share_link_views)
     or exists (select 1 from public.quotes
                 where status in ('sent', 'viewed', 'accepted', 'rejected_by_customer', 'expired')) then
    raise exception 'no se puede deshacer: hay registros de envio o respuestas del cliente (registro legal)';
  end if;
end $$;

-- Quita los alcances nuevos del límite de intentos (y sus filas, para que la restricción vuelva a valer).
delete from public.auth_rate_limits
  where scope in ('share_ip', 'share_token', 'share_respond_ip', 'quote_send_user');
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant'));

drop policy if exists quote_documents_select on storage.objects;
-- Storage protege sus tablas contra borrados directos; este permiso vale solo para esta transacción.
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'quote-documents';
delete from storage.buckets where id = 'quote-documents';

drop table if exists public.share_link_views;
drop table if exists public.share_links;

drop trigger if exists quotes_status_transition_guard on public.quotes;
drop trigger if exists quotes_send_lock_guard on public.quotes;
drop function if exists app.quotes_status_transition_guard();
drop function if exists app.quotes_send_lock_guard();
drop index if exists public.quotes_expiry;
alter table public.quotes
  drop constraint if exists quotes_send_lock_pair,
  drop constraint if exists quotes_tenant_id_current_package_id_fkey;
alter table public.quotes
  drop column if exists current_package_id,
  drop column if exists send_lock_key,
  drop column if exists send_lock_until,
  drop column if exists first_viewed_at,
  drop column if exists responded_at;

drop table if exists public.quote_packages;
drop function if exists app.quote_packages_guard();
drop function if exists app.share_links_guard();
drop function if exists app.forbid_share_view_delete();
drop function if exists app.share_views_retention_months();
