-- Deshace 20261005110000_quotes.sql
drop function if exists public.save_quote_draft(uuid, integer, uuid, jsonb, jsonb, jsonb);
drop function if exists public.create_quote(uuid, uuid);
drop table if exists public.quote_events;
drop table if exists public.quote_items;
drop table if exists public.quotes;
drop function if exists app.is_uuid_text(text);
-- Vuelve a la definición de la migración 15 (los permisos de las funciones del cálculo no se
-- restauran: quien deshace la migración 15 las borra de todos modos).
create or replace function app.calc_jsonb_int_in_range(p jsonb, p_min numeric, p_max numeric) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(
    jsonb_typeof(p) = 'number'
    and (p::numeric) = trunc(p::numeric)
    and (p::numeric) between p_min and p_max,
    false)
$$;
