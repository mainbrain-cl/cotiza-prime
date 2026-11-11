-- Deshace 20261112100000_mfa_session_gate.sql
-- Devuelve `app.current_tenant_id()` y `app.my_tenant_ids()` EXACTAMENTE a su definición de
-- 20261001120200_tenants_profiles_members.sql (mismas firma, lenguaje y permisos), la política `members_select` a la de
-- 20261105110000_member_management.sql, borra `app.second_step_pending()` y deja la
-- lista de alcances del límite de intentos como estaba en 20261103100000_invitation_accept.sql. Los contadores de los tres
-- alcances nuevos se borran (son efímeros y solo guardan huellas). No toca tablas de negocio ni datos de personas.
-- Se NIEGA a correr si las tres funciones vigentes no son EXACTAMENTE las de esa migración (se compara el md5 del cuerpo con el
-- del archivo de la migración; la prueba lo recalcula): otra migración las redefinió o ya se deshizo, y reponer las anteriores
-- pisaría ese cambio.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer 20261112100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

do $$ begin
  if not exists (
       select 1 from pg_proc p
        where p.oid = to_regprocedure('app.second_step_pending()')::oid
          and md5(p.prosrc) = 'c353f934d40d307d455b5f19086f60de')
     or not exists (
       select 1 from pg_proc p
        where p.oid = to_regprocedure('app.current_tenant_id()')::oid
          and md5(p.prosrc) = 'b41e23ef484cc1d732a031ddd2bb42ac')
     or not exists (
       select 1 from pg_proc p
        where p.oid = to_regprocedure('app.my_tenant_ids()')::oid
          and md5(p.prosrc) = '26f839d7e9aea203670ada49052553d2') then
    raise exception 'no se puede deshacer 20261112100000_mfa_session_gate: app.second_step_pending, app.current_tenant_id o app.my_tenant_ids ya no son las de esta migracion: otra migracion las redefinio o ya se deshizo; revise el orden de los deshacer';
  end if;
end $$;

create or replace function app.current_tenant_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_headers text := nullif(current_setting('request.headers', true), '');
  v_raw     text;
  v_tid     uuid;
begin
  if v_headers is null or auth.uid() is null then
    return null;
  end if;
  begin
    v_raw := nullif(v_headers::json ->> 'x-cp-tenant-id', '');
    v_tid := v_raw::uuid;
  exception when others then
    return null;
  end;
  if v_tid is null then
    return null;
  end if;
  if exists (
    select 1
    from public.members m
    join public.tenants t on t.tenant_id = m.tenant_id
    where m.tenant_id = v_tid
      and m.user_id   = auth.uid()
      and m.status    = 'active'
      and t.status    = 'active'
      and t.kind      = 'organization'
  ) then
    return v_tid;
  end if;
  return null;
end $$;

create or replace function app.my_tenant_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.tenant_id from public.members m
  where m.user_id = auth.uid() and m.status = 'active'
$$;

-- La política `members_select` vuelve a la de 20261105110000_member_management.sql (antes de borrar la función que nombra).
alter policy members_select on public.members
  using (
    user_id = (select auth.uid())
    or (tenant_id = (select app.current_tenant_id())
        and (status = 'active' or (select app.can('team.manage'))))
  );

drop function app.second_step_pending();

delete from public.auth_rate_limits where scope in ('mfa_verify_user', 'mfa_verify_user_day', 'mfa_code_used');
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant',
                   'share_ip', 'share_token', 'share_respond_ip', 'quote_send_user',
                   'intake_read_ip', 'intake_submit_ip', 'intake_submit_ip_day', 'intake_submit_form',
                   'invite_accept_user', 'invite_link_ip'));
