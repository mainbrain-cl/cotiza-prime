-- Deshace 20261112100000_mfa_session_gate.sql
-- Devuelve EXACTAMENTE a su definición anterior (mismas firma, lenguaje y permisos): `app.current_tenant_id()` y
-- `app.my_tenant_ids()` (20261001120200), `public.create_tenant` (20261001140100), `public.accept_invitation` (20261109120000),
-- `public.invitation_preview` (20261105100000) y `public.accept_current_legal_documents` (20261001120400); las políticas
-- `members_select` (20261105110000), `profiles_select` (20261105110000), `profiles_update` y `legal_acceptances_select`
-- (20261001120200 y 20261001120400) a su texto anterior; borra `app.second_step_pending()` y deja la lista de alcances del
-- límite de intentos como estaba en 20261103100000_invitation_accept.sql. Los contadores de los tres alcances nuevos se borran
-- (son efímeros y solo guardan huellas). No toca tablas de negocio ni datos de personas.
-- Se NIEGA a correr (y no cambia nada) si: (a) alguna de las siete funciones vigentes no es EXACTAMENTE la de esta migración
-- (se compara el md5 del cuerpo con el del archivo de la migración; la prueba lo recalcula): otra migración la redefinió o ya
-- se deshizo, y reponer la anterior pisaría ese cambio; (b) alguna de las cuatro políticas ya no es la de esta migración (no
-- nombra `second_step_pending`); o (c) ALGUNA OTRA función o política nombra `app.second_step_pending()`: borrarla la rompería
-- (precedente: 20261109120000). Deshacer 20261105110000 (member_management) FUERA DE ORDEN, antes que éste, deja `members_select` y
-- `profiles_select` en su texto anterior y esta migración pisaría el cambio al reaplicarse; el orden inverso de
-- `npm run test:db:rollbacks` lo evita.
--
-- ADVERTENCIA (menor 3 de la revisión de Aarón al PR #44). Este deshacer quita la protección que la base de datos pone al
-- segundo paso; no toca los factores de nadie. Dos casos que hay que tener claros ANTES de aplicarlo:
--   1. Si se aplica con la aplicación nueva (la de H-004a) funcionando, la verificación en dos pasos queda protegiendo SOLO
--      la pantalla del código: quien tenga la contraseña de una cuenta con la verificación activa puede pedir un pase parcial
--      directo a Supabase y leer y escribir por la API sin escribir el código.
--   2. Si además se vuelve atrás la aplicación (a una versión sin H-004a), las cuentas que ya la activaron entran SOLO con la
--      contraseña, sin que nadie se lo diga: el factor sigue verificado en Supabase, pero nada lo exige.
-- Mientras exista una cuenta con la verificación activa no se deshace con tráfico abierto: se deja la aplicación en
-- mantenimiento, se avisa a esas personas y no se abre de nuevo hasta reaplicar la migración o decidir el camino.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer 20261112100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

do $$
declare
  c_known constant regprocedure[] := array[
    to_regprocedure('app.second_step_pending()'), to_regprocedure('app.current_tenant_id()'),
    to_regprocedure('app.my_tenant_ids()'), to_regprocedure('public.create_tenant(text, text, text, text, text)'),
    to_regprocedure('public.accept_invitation(text)'), to_regprocedure('public.invitation_preview(text)'),
    to_regprocedure('public.accept_current_legal_documents()')];
begin
  -- (a) las siete funciones son las de esta migración
  if not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.second_step_pending()')::oid
                    and md5(p.prosrc) = 'c353f934d40d307d455b5f19086f60de')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.current_tenant_id()')::oid
                    and md5(p.prosrc) = 'b41e23ef484cc1d732a031ddd2bb42ac')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.my_tenant_ids()')::oid
                    and md5(p.prosrc) = '26f839d7e9aea203670ada49052553d2')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.create_tenant(text, text, text, text, text)')::oid
                    and md5(p.prosrc) = 'c839a9a9b303075ea5cb640c8e8a8753')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.accept_invitation(text)')::oid
                    and md5(p.prosrc) = 'c01ce93d21361b69bd2df67f7a705d8b')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.invitation_preview(text)')::oid
                    and md5(p.prosrc) = '38906c9ff65b70f2eeb3516170f12ce9')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.accept_current_legal_documents()')::oid
                    and md5(p.prosrc) = 'a0baa6767bef07d2a04620429ec22301') then
    raise exception 'no se puede deshacer 20261112100000_mfa_session_gate: alguna de las funciones (app.second_step_pending, app.current_tenant_id, app.my_tenant_ids, public.create_tenant, public.accept_invitation, public.invitation_preview, public.accept_current_legal_documents) ya no es la de esta migracion: otra migracion la redefinio o ya se deshizo; revise el orden de los deshacer';
  end if;
  -- (b) las cuatro politicas siguen siendo las de esta migracion
  if (select count(*) from pg_policies pp
       where pp.schemaname = 'public'
         and (pp.tablename, pp.policyname) in (('members', 'members_select'), ('profiles', 'profiles_select'),
                                               ('profiles', 'profiles_update'), ('legal_acceptances', 'legal_acceptances_select'))
         and (coalesce(pp.qual, '') || coalesce(pp.with_check, '')) like '%second_step_pending%') <> 4 then
    raise exception 'no se puede deshacer 20261112100000_mfa_session_gate: alguna de las politicas members_select, profiles_select, profiles_update o legal_acceptances_select ya no es la de esta migracion (no nombra app.second_step_pending); otra migracion la cambio o ya se deshizo';
  end if;
  -- (c) nadie mas nombra app.second_step_pending(): borrarla romperia esa funcion o politica
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where p.prosrc like '%second_step_pending%' and p.oid <> all (c_known::oid[])
                and n.nspname in ('public', 'app'))
     or exists (select 1 from pg_policies pp
                 where (coalesce(pp.qual, '') || coalesce(pp.with_check, '')) like '%second_step_pending%'
                   and (pp.schemaname, pp.tablename, pp.policyname) not in
                       (('public', 'members', 'members_select'), ('public', 'profiles', 'profiles_select'),
                        ('public', 'profiles', 'profiles_update'), ('public', 'legal_acceptances', 'legal_acceptances_select'))) then
    raise exception 'no se puede deshacer 20261112100000_mfa_session_gate: otra funcion o politica nombra app.second_step_pending(); desharia o rompe lo que la usa; revise el orden de los deshacer';
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

-- Las políticas vuelven a su texto anterior (antes de borrar la función que nombran).
alter policy members_select on public.members
  using (
    user_id = (select auth.uid())
    or (tenant_id = (select app.current_tenant_id())
        and (status = 'active' or (select app.can('team.manage'))))
  );
alter policy profiles_select on public.profiles
  using (
    user_id = (select auth.uid())
    or user_id in (select app.current_tenant_people())
  );
alter policy profiles_update on public.profiles
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
alter policy legal_acceptances_select on public.legal_acceptances
  using (user_id = (select auth.uid()));

create or replace function public.create_tenant(
  p_name          text,
  p_rut           text,
  p_industry      text default null,
  p_contact_email text default null,
  p_contact_phone text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid       uuid := auth.uid();
  v_confirmed boolean;
  v_rut       text;
  v_owned     integer;
  v_tenant    uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- H-001: el correo debe estar verificado, comprobado aquí y no solo en la pantalla.
  select (u.email_confirmed_at is not null) into v_confirmed from auth.users u where u.id = v_uid;
  if not coalesce(v_confirmed, false) then
    raise exception 'Verifica tu correo antes de crear una organización' using errcode = '42501';
  end if;

  -- Formato del correo de contacto: se comprueba aquí y no solo en la pantalla.
  if p_contact_email is not null and p_contact_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'El correo de contacto no es válido' using errcode = '22023';
  end if;

  v_rut := app.normalize_rut(p_rut);
  if not app.is_valid_rut(v_rut) then
    raise exception 'El RUT no es válido' using errcode = '22023';
  end if;

  -- Tope por persona, contra el abuso del registro abierto. El candado evita que dos
  -- peticiones simultáneas pasen el tope a la vez.
  perform pg_advisory_xact_lock(hashtextextended('create_tenant:' || v_uid::text, 0));
  select count(*) into v_owned
  from public.members m
  join public.tenants t on t.tenant_id = m.tenant_id and t.kind = 'organization'
  where m.user_id = v_uid and m.role = 'owner' and m.status = 'active';
  if v_owned >= app.max_tenants_per_user() then
    raise exception 'Alcanzaste el máximo de % organizaciones', app.max_tenants_per_user()
      using errcode = '53400';
  end if;

  insert into public.tenants (name, rut, industry, contact_email, contact_phone, created_by)
  values (btrim(p_name), v_rut, p_industry, p_contact_email, p_contact_phone, v_uid)
  returning tenant_id into v_tenant;

  insert into public.members (tenant_id, user_id, role) values (v_tenant, v_uid, 'owner');
  insert into public.numbering_settings (tenant_id, updated_by) values (v_tenant, v_uid);
  update public.profiles set last_tenant_id = v_tenant where user_id = v_uid;

  return v_tenant;
end $$;

create or replace function public.accept_invitation(p_token_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid         uuid := auth.uid();
  v_email       text;
  v_confirmed   timestamptz;
  v_inv         public.invitations;
  v_state       text;
  v_member      public.members;
  v_member_id   uuid;
  v_role        text;
  v_already     boolean := false;
  v_reactivated boolean := false;
  v_sender      uuid;
begin
  -- 1. sesión, y que la transacción no sea de solo lectura
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- Un GET de PostgREST corre en solo lectura: ahí no se podría contar un fallo, así que no se atiende (ver arriba).
  if current_setting('transaction_read_only') = 'on' then
    raise exception 'read_only' using errcode = '25006';
  end if;
  -- Un candado por cuenta, hasta el fin de la transacción: las llamadas de una misma cuenta pasan en fila, así que
  -- la pregunta «¿está bloqueada?» ve los fallos que otras llamadas simultáneas ya sumaron (ver arriba).
  perform pg_advisory_xact_lock(hashtextextended('invite_accept_user|' || v_uid::text, 0));
  -- 2. forma de la huella
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  -- 3. correo de la cuenta verificado (sale de auth.users, nunca de la petición)
  -- La garantía «solo el mismo correo» descansa en que `email_confirmed_at` signifique que la persona ES dueña de ese
  -- correo. Eso solo es cierto si en el proyecto de Supabase de PRODUCCIÓN están activos «Confirm email»
  -- (`enable_confirmations`) y «Secure email change» (`double_confirm_changes`), hoy solo escritos en
  -- `supabase/config.toml` (base local). H-009 exige en el proyecto de producción: Confirm email ON, Secure email
  -- change ON y sin proveedores externos (OAuth) ni ingreso anónimo, salvo decisión registrada.
  select u.email::text, u.email_confirmed_at into v_email, v_confirmed
    from auth.users u where u.id = v_uid and u.deleted_at is null;
  if not found or v_email is null or v_confirmed is null then
    return jsonb_build_object('result', 'unverified');
  end if;
  -- 4. límite de aceptaciones fallidas
  if app.invitation_accept_locked(v_uid) then
    return jsonb_build_object('result', 'rate_limited');
  end if;
  -- 5. la invitación, por la huella del código, y bloqueada: dos aceptaciones a la vez, o aceptar mientras otro
  --    cancela o reenvía, se ordenan aquí. Si un reenvío cambió el código mientras se esperaba el candado, la fila
  --    ya no cumple la condición y el resultado es `not_found`.
  select * into v_inv from public.invitations i where i.token_sha256 = p_token_sha256 for update;
  if not found then
    perform app.invitation_accept_fail(v_uid);
    return jsonb_build_object('result', 'not_found');
  end if;
  -- 6 y 7. estado y correo
  v_state := app.invitation_state(v_inv, v_uid, v_email);
  if v_state = 'wrong_email' then
    perform app.invitation_accept_fail(v_uid);
    perform app.invitation_audit_wrong_email(v_inv, v_uid, 'accept');
    return jsonb_build_object('result', 'wrong_email');
  end if;
  if v_state = 'accepted_by_you' then
    -- La misma persona repite el clic (o recarga): sigue dentro, no es un error.
    select m.role into v_role from public.members m
     where m.tenant_id = v_inv.tenant_id and m.user_id = v_uid;
    return jsonb_build_object('result', 'accepted', 'tenant_id', v_inv.tenant_id, 'role', v_role,
                              'already_member', true, 'reactivated', false);
  end if;
  if v_state <> 'ok' then
    return jsonb_build_object('result', v_state);
  end if;
  -- D3: quien figura como invitador del nuevo miembro es quien envió el enlace por última vez (quien reenvió, si hubo
  --    reenvío; si no, quien creó la invitación). Se lee de la fila ya bloqueada: un reenvío cambia el código y
  --    `resent_by` en el mismo `update`.
  v_sender := coalesce(v_inv.resent_by, v_inv.invited_by);
  -- Menor 1 del PR #35: la fila de `members` guarda además quien CREÓ la invitación (`invitation_created_by`), que puede ser
  --    otra persona que quien envió el enlace. Se escribe junto a `invited_by`, solo al entrar o al reactivar.

  -- 8. membresía. El rol sale SIEMPRE de la invitación.
  select * into v_member from public.members m
   where m.tenant_id = v_inv.tenant_id and m.user_id = v_uid for update;
  if found and v_member.status = 'active' then
    -- Ya es miembro: su rol no se toca (cambiarlo es de H-010).
    v_member_id := v_member.id;
    v_role := v_member.role;
    v_already := true;
  elsif found then
    -- La habían quitado: se reactiva su fila con el rol de la invitación.
    update public.members
       set status = 'active', removed_at = null, removed_by = null, role = v_inv.role,
           joined_at = now(), invited_by = v_sender,
           invitation_created_by = v_inv.invited_by
     where tenant_id = v_inv.tenant_id and id = v_member.id;
    v_member_id := v_member.id;
    v_role := v_inv.role;
    v_reactivated := true;
  else
    insert into public.members (tenant_id, user_id, role, status, invited_by, invitation_created_by)
    values (v_inv.tenant_id, v_uid, v_inv.role, 'active', v_sender, v_inv.invited_by)
    returning id into v_member_id;
    v_role := v_inv.role;
  end if;

  -- 9. la invitación queda aceptada y el correo (dato personal) se borra: ya vive en la cuenta.
  update public.invitations
     set status = 'accepted', accepted_at = now(), accepted_by = v_uid, member_id = v_member_id,
         email_enc = null, email_hash = null, email_binding = null
   where tenant_id = v_inv.tenant_id and id = v_inv.id;

  perform app.write_audit(v_inv.tenant_id, 'user', v_uid, 'invitation.accepted', 'invitation', v_inv.id, 'success',
    jsonb_build_object('role', v_inv.role, 'already_member', v_already, 'reactivated', v_reactivated,
                       'created_by', v_inv.invited_by, 'sent_by', v_sender));
  return jsonb_build_object('result', 'accepted', 'tenant_id', v_inv.tenant_id, 'role', v_role,
                            'already_member', v_already, 'reactivated', v_reactivated);
end $$;

create or replace function public.invitation_preview(p_token_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text;
  v_confirmed timestamptz;
  v_inv       public.invitations;
  v_state     text;
  v_current_role text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- Mismo comportamiento que `accept_invitation` ante un GET de PostgREST (transacción de solo lectura).
  if current_setting('transaction_read_only') = 'on' then
    raise exception 'read_only' using errcode = '25006';
  end if;
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  -- La garantía «solo el mismo correo» descansa en que `email_confirmed_at` signifique que la persona ES dueña de ese
  -- correo. Eso solo es cierto si en el proyecto de Supabase de PRODUCCIÓN están activos «Confirm email»
  -- (`enable_confirmations`) y «Secure email change» (`double_confirm_changes`), hoy solo escritos en
  -- `supabase/config.toml` (base local). H-009 exige en el proyecto de producción: Confirm email ON, Secure email
  -- change ON y sin proveedores externos (OAuth) ni ingreso anónimo, salvo decisión registrada.
  select u.email::text, u.email_confirmed_at into v_email, v_confirmed
    from auth.users u where u.id = v_uid and u.deleted_at is null;
  if not found or v_email is null or v_confirmed is null then
    return jsonb_build_object('result', 'unverified');
  end if;
  -- Solo LEE el tope: si la cuenta ya está bloqueada por intentos de aceptar fallidos, lo dice. Nunca suma un fallo.
  if app.invitation_accept_locked(v_uid) then
    return jsonb_build_object('result', 'rate_limited');
  end if;
  select * into v_inv from public.invitations i where i.token_sha256 = p_token_sha256;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  -- Para una cuenta que no es la invitada, `wrong_email` en cualquier estado (ver `app.invitation_state`).
  v_state := app.invitation_state(v_inv, v_uid, v_email);
  if v_state = 'wrong_email' then
    return jsonb_build_object('result', 'wrong_email');
  end if;
  if v_state = 'accepted_by_you' then
    return jsonb_build_object('result', 'accepted', 'tenant_id', v_inv.tenant_id);
  end if;
  if v_state <> 'ok' then
    return jsonb_build_object('result', v_state);
  end if;
  -- Si ya eres miembro activo, aceptar no cambia tu rol: se muestra el rol actual para que la pantalla no prometa
  -- el de la invitación.
  select m.role into v_current_role from public.members m
   where m.tenant_id = v_inv.tenant_id and m.user_id = v_uid and m.status = 'active';
  return jsonb_build_object(
    'result', 'ok',
    'already_member', v_current_role is not null,
    'current_role', v_current_role,
    'tenant_id', v_inv.tenant_id,
    'tenant_name', (select t.name from public.tenants t where t.tenant_id = v_inv.tenant_id),
    'inviter_name', (select nullif(btrim(p.full_name), '') from public.profiles p where p.user_id = v_inv.invited_by),
    'role', v_inv.role,
    'expires_at', v_inv.expires_at);
end $$;

create or replace function public.accept_current_legal_documents() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_headers json := nullif(current_setting('request.headers', true), '')::json;
  v_ip      inet;
  v_count   integer;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  begin v_ip := nullif(v_headers ->> 'x-cp-client-ip', '')::inet;
  exception when others then v_ip := null; end;

  with ins as (
    insert into public.legal_acceptances (user_id, document_id, context, origin_ip, user_agent)
    select v_uid, d.id, 'reaccept', v_ip, left(nullif(v_headers ->> 'user-agent', ''), 300)
    from public.legal_documents d
    where d.is_current
    on conflict (user_id, document_id) do nothing
    returning 1
  )
  select count(*)::integer into v_count from ins;
  return v_count;
end $$;

drop function app.second_step_pending();

delete from public.auth_rate_limits where scope in ('mfa_verify_user', 'mfa_verify_user_day', 'mfa_code_used');
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant',
                   'share_ip', 'share_token', 'share_respond_ip', 'quote_send_user',
                   'intake_read_ip', 'intake_submit_ip', 'intake_submit_ip_day', 'intake_submit_form',
                   'invite_accept_user', 'invite_link_ip'));
