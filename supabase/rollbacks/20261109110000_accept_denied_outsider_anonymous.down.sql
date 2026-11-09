-- Deshace 20261109110000_accept_denied_outsider_anonymous.sql
-- Devuelve `app.invitation_audit_wrong_email` a la definición de 20261103100000_invitation_accept.sql (lenguaje sql, el
-- mismo cuerpo, los mismos permisos). No cambia datos: las filas escritas sin autor siguen sin autor y las copias de la
-- organización «plataforma» quedan (la auditoría es de solo agregar). Desde aquí los intentos de gente de fuera vuelven a
-- guardar su id en la organización de la invitación.
create or replace function app.invitation_audit_wrong_email(i public.invitations, p_user_id uuid, p_step text) returns void
language sql volatile security definer set search_path = '' as $$
  select app.write_audit(i.tenant_id, 'user', p_user_id, 'invitation.accept_denied', 'invitation', i.id, 'denied',
    jsonb_build_object('reason', 'wrong_email', 'step', p_step))
$$;
revoke all on function app.invitation_audit_wrong_email(public.invitations, uuid, text) from public, anon, authenticated;
