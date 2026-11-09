-- Sprint 5 · H-009/H-010 · Corrección de la decisión de Aarón en el PR #33 (2026-11-09): el intento de aceptar una
-- invitación ajena, hecho por alguien de FUERA de la organización, queda en la auditoría de esa organización SIN autor.
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261109110000_accept_denied_outsider_anonymous.down.sql
-- Especificación: docs/arquitectura/sprint-5-equipo-y-permisos.md, «Corrección: el intento de alguien de fuera queda sin
-- autor (2026-11-09)».
--
-- El problema: cuando una persona prueba un código real de una invitación dirigida a otro correo, la fila
-- `invitation.accept_denied` de la organización de la invitación guardaba el id de esa persona, su dirección IP y su
-- navegador. El Dueño de la organización lee esa auditoría: recibía el id (y la IP y el navegador) de alguien que no es
-- ni fue de su organización. Es una fuga entre organizaciones (la prueba de aislamiento la detectaba según el orden en
-- que corrían los archivos).
--
-- Qué hace (solo redefine `app.invitation_audit_wrong_email`; misma firma, mismo nombre, mismos permisos):
--   1. Si la persona tiene o tuvo una fila en `members` de la organización de la invitación (en cualquier estado), la
--      fila de la organización queda EXACTAMENTE como antes: con su id, IP, navegador y correlación.
--   2. Si no es ni fue de esa organización, la fila de la organización queda SIN autor: `actor_type = 'user'` y
--      `actor_user_id`, `origin_ip`, `user_agent` y `correlation_id` en nulo. Se mantienen la acción, la invitación
--      (`resource_id`), el resultado, el momento y `details = {reason, step}`.
--   3. Siempre (sea o no de la organización, para que el trabajo sea el mismo) se escribe una copia completa en la
--      organización «plataforma», con el id, la IP, el navegador y `details` más `invitation_tenant_id`. Solo la ve
--      Main Brain: sirve para contener una cuenta que prueba códigos ajenos (campo «Actor» de SEGURIDAD.md §9). Se une
--      con la fila de la organización por `resource_id` y por la hora (misma transacción). Mismo precedente que
--      `tenant.access_denied`.
--
-- Qué NO hace: no toca `accept_invitation` ni `invitation_state` (la respuesta y el tiempo de H-009 no cambian), no
-- bloquea filas de `members` (solo las lee), no cambia las filas ya escritas (la auditoría es de solo agregar; en la
-- base local se vacían con `db reset`) y no cambia tablas ni permisos. La función pasa de `sql` a `plpgsql` porque hace
-- falta atrapar una IP o una correlación mal escritas sin abortar la transacción (que debe persistir el conteo de
-- fallos), igual que `app.write_audit`.
create or replace function app.invitation_audit_wrong_email(i public.invitations, p_user_id uuid, p_step text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_headers json    := nullif(current_setting('request.headers', true), '')::json;
  v_details jsonb   := jsonb_build_object('reason', 'wrong_email', 'step', p_step);
  v_insider boolean := exists (
    select 1 from public.members m where m.tenant_id = i.tenant_id and m.user_id = p_user_id);
  v_ip      inet;
  v_corr    uuid;
begin
  begin v_ip := nullif(v_headers ->> 'x-cp-client-ip', '')::inet;
  exception when others then v_ip := null; end;
  begin v_corr := nullif(v_headers ->> 'x-cp-request-id', '')::uuid;
  exception when others then v_corr := null; end;
  -- La fila de la organización de la invitación: con autor solo si la persona es o fue de esa organización.
  insert into public.audit_log
    (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, result,
     origin_ip, user_agent, correlation_id, details)
  values
    (i.tenant_id, 'user', case when v_insider then p_user_id end,
     'invitation.accept_denied', 'invitation', i.id, 'denied',
     case when v_insider then v_ip end,
     case when v_insider then left(nullif(v_headers ->> 'user-agent', ''), 300) end,
     case when v_insider then v_corr end,
     v_details);
  -- La copia completa, solo para Main Brain.
  perform app.write_audit(app.platform_tenant_id(), 'user', p_user_id, 'invitation.accept_denied', 'invitation',
    i.id, 'denied', v_details || jsonb_build_object('invitation_tenant_id', i.tenant_id));
end $$;
revoke all on function app.invitation_audit_wrong_email(public.invitations, uuid, text) from public, anon, authenticated;
