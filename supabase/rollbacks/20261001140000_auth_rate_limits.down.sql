-- Deshace 20261001140000_auth_rate_limits.sql
drop function if exists public.auth_limit_clear(text, text);
drop function if exists public.auth_limit_record_failure(text, text, integer, integer, integer);
drop function if exists public.auth_limit_locked_until(text, text);
drop table if exists public.auth_rate_limits;
