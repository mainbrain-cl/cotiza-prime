-- Deshace 20261001160100_rate_limit_denied_scope.sql
delete from public.auth_rate_limits where scope = 'tenant_denied_user';
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip'));
