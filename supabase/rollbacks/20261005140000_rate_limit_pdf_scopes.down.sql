-- Deshace 20261005140000_rate_limit_pdf_scopes.sql
delete from public.auth_rate_limits where scope in ('pdf_user', 'pdf_tenant');
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user'));
