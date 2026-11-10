-- Deshace 20261109130000_invitation_audit_active_only.sql
-- Devuelve `app.invitation_audit_wrong_email` a la definición de 20261109110000_accept_denied_outsider_anonymous.sql
-- (plpgsql, mismo cuerpo, mismos permisos): quien tiene o tuvo una fila en `members` de la organización vuelve a dejar
-- su id, su IP, su navegador y su correlación, también si ya fue quitado. No cambia datos: las filas ya escritas quedan
-- como están (la auditoría es de solo agregar).
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer de 20261109130000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

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
