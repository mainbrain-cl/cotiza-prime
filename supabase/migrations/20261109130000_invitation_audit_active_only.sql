-- Sprint 5 · H-009/H-010 · Menor 1 de la revisión de Aarón al PR #36 (2026-11-10): quien FUE miembro (quitado) ya no
-- entrega su IP, su navegador ni su correlación actuales a su organización anterior.
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261109130000_invitation_audit_active_only.down.sql
-- Especificación: docs/arquitectura/sprint-5-equipo-y-permisos.md, «Menores del #36 (2026-11-10)».
--
-- El problema: `20261109110000_accept_denied_outsider_anonymous` deja la fila `invitation.accept_denied` de la
-- organización con el id, la IP, el navegador y la correlación de quien tiene o tuvo una fila en `members` de esa
-- organización, en cualquier estado. Quien ya fue quitado (`status = 'removed'`) sigue siendo alguien que el Dueño puede
-- reconocer por su id (H-010 deja leer su nombre), pero su IP y su navegador de HOY, desde otro lugar y otra cuenta de
-- trabajo, no tienen por qué llegar a la organización que lo sacó.
--
-- Qué hace (solo redefine `app.invitation_audit_wrong_email`; misma firma, mismo lenguaje, mismos permisos):
--   1. Si la persona tiene o tuvo una fila en `members` de la organización de la invitación (en cualquier estado), la
--      fila de la organización conserva SIEMPRE su id (`actor_user_id`).
--   2. `origin_ip`, `user_agent` y `correlation_id` se guardan solo si esa fila es `active`. Quien fue quitado queda con
--      su id pero sin IP, navegador ni correlación.
--   3. Si no es ni fue de la organización: la fila queda sin autor, como hoy (`actor_user_id`, IP, navegador y
--      correlación en nulo).
--   4. La copia completa en la organización «plataforma» no cambia: siempre con el id, la IP, el navegador y
--      `invitation_tenant_id`; solo la ve Main Brain.
--
-- Qué NO hace: no toca `accept_invitation` ni `invitation_state`, no bloquea filas de `members` (solo las lee), no cambia
-- las filas ya escritas (la auditoría es de solo agregar) y no cambia tablas ni permisos.
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia `set local lock_timeout = '3s'` y, justo después, la
-- verificación de que el valor quedó puesto (si la herramienta que aplica el archivo no lo respetara, se detiene).
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261109130000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

create or replace function app.invitation_audit_wrong_email(i public.invitations, p_user_id uuid, p_step text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_headers json    := nullif(current_setting('request.headers', true), '')::json;
  v_details jsonb   := jsonb_build_object('reason', 'wrong_email', 'step', p_step);
  -- Tiene o tuvo una fila en `members` de esa organización (cualquier estado): se conserva su id.
  v_known   boolean := exists (
    select 1 from public.members m where m.tenant_id = i.tenant_id and m.user_id = p_user_id);
  -- Hoy es miembro activo: solo entonces se conservan también su IP, su navegador y su correlación.
  v_active  boolean := exists (
    select 1 from public.members m where m.tenant_id = i.tenant_id and m.user_id = p_user_id and m.status = 'active');
  v_ip      inet;
  v_corr    uuid;
begin
  begin v_ip := nullif(v_headers ->> 'x-cp-client-ip', '')::inet;
  exception when others then v_ip := null; end;
  begin v_corr := nullif(v_headers ->> 'x-cp-request-id', '')::uuid;
  exception when others then v_corr := null; end;
  -- La fila de la organización de la invitación: con id si la persona es o fue de esa organización; con IP, navegador
  -- y correlación solo si es miembro activo.
  insert into public.audit_log
    (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, result,
     origin_ip, user_agent, correlation_id, details)
  values
    (i.tenant_id, 'user', case when v_known then p_user_id end,
     'invitation.accept_denied', 'invitation', i.id, 'denied',
     case when v_active then v_ip end,
     case when v_active then left(nullif(v_headers ->> 'user-agent', ''), 300) end,
     case when v_active then v_corr end,
     v_details);
  -- La copia completa, solo para Main Brain.
  perform app.write_audit(app.platform_tenant_id(), 'user', p_user_id, 'invitation.accept_denied', 'invitation',
    i.id, 'denied', v_details || jsonb_build_object('invitation_tenant_id', i.tenant_id));
end $$;
revoke all on function app.invitation_audit_wrong_email(public.invitations, uuid, text) from public, anon, authenticated;
