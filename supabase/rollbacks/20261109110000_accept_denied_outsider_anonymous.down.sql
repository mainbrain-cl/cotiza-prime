-- Deshace 20261109110000_accept_denied_outsider_anonymous.sql
-- Devuelve `app.invitation_audit_wrong_email` a la definición de 20261103100000_invitation_accept.sql (lenguaje sql, el
-- mismo cuerpo, los mismos permisos). No cambia datos: las filas escritas sin autor siguen sin autor y las copias de la
-- organización «plataforma» quedan (la auditoría es de solo agregar). Desde aquí los intentos de gente de fuera vuelven a
-- guardar su id en la organización de la invitación.
-- Orden: se niega a correr si la función vigente `app.invitation_audit_wrong_email` ya no es la de esta migración (se
-- compara el md5 de su cuerpo con el de 20261109110000_accept_denied_outsider_anonymous.sql). Es lo que pasa si se corre
-- ANTES que el deshacer de 20261109130000 (la función vigente es la de esa migración): reponer la versión original
-- dejaría que la organización vuelva a recibir el id de personas de fuera, y además se saltaría el orden. Primero va
-- el deshacer de 20261109130000. Si el md5 no coincide en un ambiente real, ver docs/arquitectura/modelo-datos.md §9.4.
-- Cambio de un archivo ya integrado (menor 3 del PR #38, 2026-11-11): la guarda solo vuelve más estricto el deshacer,
-- mismo precedente aprobado por Aarón en el PR #38 (punto 7: guardas más estrictas en 20261106100000 y 20261109120000).
-- Es anterior a la guardia 15 (lock_timeout rige desde 20261109120000): no lo lleva.
do $$ begin
  -- La función vigente tiene que ser EXACTAMENTE la de esta migración: se compara el md5 de su cuerpo con el del cuerpo de
  -- 20261109110000_accept_denied_outsider_anonymous.sql (la prueba AD lo recalcula del archivo).
  if not exists (
       select 1 from pg_proc p
        where p.oid = to_regprocedure('app.invitation_audit_wrong_email(public.invitations, uuid, text)')::oid
          and md5(p.prosrc) = '51b1a14481e5a11a109d28984d8d393d') then
    raise exception 'no se puede deshacer 20261109110000_accept_denied_outsider_anonymous: la funcion app.invitation_audit_wrong_email vigente ya no es la de esta migracion: otra migracion la redefinio (por ejemplo 20261109130000) o ya se deshizo; revise el orden de los deshacer';
  end if;
end $$;

create or replace function app.invitation_audit_wrong_email(i public.invitations, p_user_id uuid, p_step text) returns void
language sql volatile security definer set search_path = '' as $$
  select app.write_audit(i.tenant_id, 'user', p_user_id, 'invitation.accept_denied', 'invitation', i.id, 'denied',
    jsonb_build_object('reason', 'wrong_email', 'step', p_step))
$$;
revoke all on function app.invitation_audit_wrong_email(public.invitations, uuid, text) from public, anon, authenticated;
