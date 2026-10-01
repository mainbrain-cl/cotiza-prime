-- H-012 · Tope a los registros de "acceso denegado a una organización". Quien prueba direcciones de
-- organizaciones ajenas no puede llenar la auditoría: el servidor cuenta los intentos por persona y
-- deja de registrar al pasar el tope. Reutiliza el limitador, con un alcance nuevo.
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261001160100_rate_limit_denied_scope.down.sql
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user'));
