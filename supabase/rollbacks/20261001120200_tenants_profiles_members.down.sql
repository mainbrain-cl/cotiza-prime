-- Deshace 20261001120200_tenants_profiles_members.sql
-- Orden: la política de profiles lee members, así que profiles va primero.
drop table if exists public.profiles;
drop table if exists public.members;
drop table if exists public.tenants;
drop function if exists app.has_role(text[]);
drop function if exists app.current_member_role();
drop function if exists app.my_tenant_ids();
drop function if exists app.current_tenant_id();
