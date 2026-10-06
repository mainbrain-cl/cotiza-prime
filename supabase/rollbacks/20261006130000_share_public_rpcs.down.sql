-- Deshace 20261006130000_share_public_rpcs.sql
drop function if exists public.share_link_respond(text, uuid, uuid, text, text, text, text, text, inet, text, text);
drop function if exists public.share_link_record_view(text, text, text);
drop function if exists public.share_link_read(text);
drop function if exists app.short_user_agent(text);
drop function if exists app.expire_quote(uuid, uuid);
