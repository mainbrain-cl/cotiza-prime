-- H-028 · Tope a los PDF que se arman. Generar un PDF de 200 líneas tarda decenas de segundos y usa
-- cientos de MB: el servidor cuenta los PDF armados por persona y por organización y responde 429 al
-- pasar el tope. Reutiliza el limitador, con dos alcances nuevos.
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261005140000_rate_limit_pdf_scopes.down.sql
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant'));
