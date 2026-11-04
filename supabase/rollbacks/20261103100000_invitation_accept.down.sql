-- Deshace 20261103100000_invitation_accept.sql
-- Borra las dos funciones de H-009 y sus ayudas, y devuelve la lista de alcances del límite de intentos a la de
-- antes. No toca invitaciones ni miembros: lo que ya se aceptó queda aceptado (la tabla `invitations` es de
-- H-008). Los contadores de los dos alcances nuevos se borran (son efímeros y solo guardan huellas).
drop function if exists public.accept_invitation(text);
drop function if exists public.invitation_preview(text);
drop function if exists app.invitation_audit_wrong_email(public.invitations, uuid, text);
drop function if exists app.invitation_state(public.invitations, uuid, text);
drop function if exists app.invitation_accept_fail(uuid);
drop function if exists app.invitation_accept_locked(uuid);
drop function if exists app.invitation_accept_key(uuid);
drop function if exists app.invitation_accept_lock_seconds();
drop function if exists app.invitation_accept_window_seconds();
drop function if exists app.invitation_accept_max_failures();

delete from public.auth_rate_limits where scope in ('invite_accept_user', 'invite_link_ip');
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant',
                   'share_ip', 'share_token', 'share_respond_ip', 'quote_send_user',
                   'intake_read_ip', 'intake_submit_ip', 'intake_submit_ip_day', 'intake_submit_form'));
