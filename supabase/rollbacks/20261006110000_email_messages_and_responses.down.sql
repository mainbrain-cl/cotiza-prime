-- Deshace 20261006110000_email_messages_and_responses.sql
drop table if exists public.quote_responses;
alter table public.share_links drop constraint if exists share_links_email_message_fk;
drop table if exists public.email_messages;
drop function if exists app.email_messages_guard();

-- Los enlaces apuntaban a los correos que se acaban de borrar: sin ellos quedarían enlaces sin correo
-- y la migración no podría volver a aplicarse. Se retiran con sus aperturas (las reglas de solo
-- agregar se apagan solo para esto, dentro de esta transacción).
alter table public.share_link_views disable trigger share_link_views_no_delete;
delete from public.share_link_views;
alter table public.share_link_views enable trigger share_link_views_no_delete;
alter table public.share_links disable trigger share_links_guard;
delete from public.share_links;
alter table public.share_links enable trigger share_links_guard;
