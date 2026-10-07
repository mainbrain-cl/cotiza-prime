-- Deshace 20261006160000_share_notice_recipients.sql
-- Solo quita las tres funciones. Los avisos ya registrados en email_messages (kind internal_notice) son
-- parte del registro de correos y se conservan.
drop function if exists public.internal_notice_settle(uuid, uuid, text, text, text);
drop function if exists public.internal_notice_register(uuid, uuid, uuid, uuid, uuid, text, text);
drop function if exists public.share_notice_recipients(uuid, uuid, uuid);
