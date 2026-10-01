-- Deshace 20261001120300_audit_log.sql
drop trigger if exists tenants_audit on public.tenants;
drop trigger if exists members_audit on public.members;
drop table if exists public.audit_log;
drop function if exists app.audit_row_change();
drop function if exists app.forbid_audit_delete();
