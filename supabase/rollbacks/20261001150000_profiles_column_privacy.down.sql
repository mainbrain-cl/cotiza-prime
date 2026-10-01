-- Deshace 20261001150000_profiles_column_privacy.sql
drop function if exists public.my_last_tenant_id();
revoke select on public.profiles from authenticated;
grant select on public.profiles to authenticated;
