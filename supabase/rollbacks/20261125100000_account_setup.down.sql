-- Deshace 20261125100000_account_setup.sql
-- Quita el disparador `forbid_email_change` de `auth.users` y su función, devuelve EXACTAMENTE a su definición anterior (mismas firma,
-- lenguaje y permisos) a `app.current_tenant_id()`, `app.my_tenant_ids()`, `public.create_tenant`, `public.accept_invitation` y
-- `public.invitation_preview` (20261112100000_mfa_session_gate) y a `app.handle_new_user` (20261001120400_legal), la política
-- `profiles_update`, `profiles_select` y `members_select` a su texto anterior, borra las ayudas y funciones nuevas (`app.session_alive`, `app.session_from_email_link`,
-- `app.account_ready`, `app.setup_denied`, `app.account_setup_verdict`, `public.account_setup_preflight`, `public.my_account_ready` y
-- `public.complete_account_setup`), deja la lista de alcances del límite de intentos como estaba en 20261113100000 (borra antes los
-- contadores de `signup_email`) y borra las dos columnas `profiles.account_ready_at` y `profiles.signup_email`.
-- SE PIERDE: qué cuentas estaban terminadas y su correo de alta. NO se restauran las aceptaciones de términos que
-- `complete_account_setup` descartó (quedan en la auditoría como `legal.acceptance_discarded`). Las cuentas, los perfiles, las
-- organizaciones y todo lo demás no se tocan.
-- Se NIEGA a correr (y no cambia nada) si: (a) alguna de las funciones que la migración define o reemplaza ya no es EXACTAMENTE la de
-- la migración (se compara el md5 del cuerpo con el del archivo; la prueba lo recalcula): otra migración la redefinió o ya se deshizo,
-- y reponer la anterior pisaría ese cambio; (b) el disparador o alguna de las tres políticas ya no son los de la migración; o (c)
-- ALGUNA OTRA función o política nombra las ayudas nuevas o las columnas (borrarlas la rompería).
-- ADVERTENCIA. Con la aplicación de H-116 funcionando, el deshacer deja de exigir cuenta terminada y de cerrar el pase de una sesión
-- cerrada: quien tenga una cuenta creada por otra persona vuelve a poder crear organizaciones y aceptar invitaciones. Aplicarlo solo con
-- la aplicación en mantenimiento o ya vuelta atrás a la etapa anterior. Va ANTES del deshacer de 20261123100000_quote_text_fields.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'el deshacer 20261125100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

do $$
declare
  c_known constant regprocedure[] := array[
    to_regprocedure('app.current_tenant_id()'),
    to_regprocedure('app.my_tenant_ids()'),
    to_regprocedure('public.create_tenant(text, text, text, text, text)'),
    to_regprocedure('public.accept_invitation(text)'),
    to_regprocedure('public.invitation_preview(text)'),
    to_regprocedure('app.handle_new_user()'),
    to_regprocedure('app.forbid_email_change()'),
    to_regprocedure('app.session_alive()'),
    to_regprocedure('app.session_from_email_link()'),
    to_regprocedure('app.account_ready(uuid)'),
    to_regprocedure('app.setup_denied(uuid, text)'),
    to_regprocedure('app.account_setup_verdict(uuid, uuid, text, text, text, boolean)'),
    to_regprocedure('public.account_setup_preflight(text, text, text)'),
    to_regprocedure('public.my_account_ready()'),
    to_regprocedure('public.complete_account_setup(text, text, text)')];
begin
  -- (a) las funciones vigentes son EXACTAMENTE las de esta migración (se compara el md5 del cuerpo con el del archivo): otra migración
  --     las redefinió o ya se deshizo, y reponer las anteriores pisaría ese cambio
  if not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.current_tenant_id()')::oid and md5(p.prosrc) = '3b7ebc97e3c78daf1fac382753f00e70')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.my_tenant_ids()')::oid and md5(p.prosrc) = '23dbeec9a357ef84202cc8cf32984c2f')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.create_tenant(text, text, text, text, text)')::oid and md5(p.prosrc) = 'e5853029601c911ecb3d26c0552943bf')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.accept_invitation(text)')::oid and md5(p.prosrc) = '7e4d944926063a0286fb50c7ae9ba42b')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.invitation_preview(text)')::oid and md5(p.prosrc) = 'dbbdf62639636dfb281f3bf97ad95387')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.handle_new_user()')::oid and md5(p.prosrc) = '23f224fc8905f24a54ded28f70678e4d')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.forbid_email_change()')::oid and md5(p.prosrc) = '1d6c243817afa1f26ed5999e5153f6b7')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.session_alive()')::oid and md5(p.prosrc) = 'f995adb19c83bfec36f7b288a7579bf8')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.session_from_email_link()')::oid and md5(p.prosrc) = 'b23f8b6094bef369d5577c34f6494394')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.account_ready(uuid)')::oid and md5(p.prosrc) = '2e1005b8446e4c161578b2c39e1e85e5')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.setup_denied(uuid, text)')::oid and md5(p.prosrc) = '1c0512dae0eda26d39c1dc9862e830a3')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('app.account_setup_verdict(uuid, uuid, text, text, text, boolean)')::oid and md5(p.prosrc) = 'b66a9ff75004887677c3fb1b27d1fdbe')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.account_setup_preflight(text, text, text)')::oid and md5(p.prosrc) = 'f593eaddf4cb58d111a9ed3d89c257f6')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.my_account_ready()')::oid and md5(p.prosrc) = '9cde4e55b01998c838359c1b9ede9221')
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.complete_account_setup(text, text, text)')::oid and md5(p.prosrc) = 'be1ba2cd7fbf3d2a82ed36311b64e9ce') then
    raise exception 'no se puede deshacer 20261125100000_account_setup: alguna de las funciones que esta migracion define o reemplaza ya no es la de esta migracion (otra migracion la redefinio o ya se deshizo); revise el orden de los deshacer';
  end if;
  -- (b) el disparador del cambio de correo y las tres politicas siguen siendo los de esta migracion
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'auth.users'::regclass and t.tgname = 'forbid_email_change' and not t.tgisinternal)
     or (select count(*) from pg_policies pp
          where pp.schemaname = 'public'
            and (pp.tablename, pp.policyname) in (('profiles', 'profiles_update'), ('profiles', 'profiles_select'), ('members', 'members_select'))
            and (coalesce(pp.qual, '') || coalesce(pp.with_check, '')) like '%session_alive%') <> 3 then
    raise exception 'no se puede deshacer 20261125100000_account_setup: el disparador forbid_email_change o alguna de las politicas profiles_update, profiles_select o members_select ya no son los de esta migracion; revise el orden de los deshacer';
  end if;
  -- (c) nadie mas nombra lo que se va a borrar (las ayudas nuevas ni las dos columnas): borrarlas romperia esa funcion o politica
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('public', 'app') and p.oid <> all (c_known::oid[])
                and (p.prosrc ~ '(session_alive|session_from_email_link|account_ready|account_setup_verdict|setup_denied|forbid_email_change|complete_account_setup|account_setup_preflight|my_account_ready|signup_email)'))
     or exists (select 1 from pg_policies pp
                 where (coalesce(pp.qual, '') || coalesce(pp.with_check, '')) ~ '(session_alive|account_ready|signup_email)'
                   and (pp.schemaname, pp.tablename, pp.policyname) not in
                       (('public', 'profiles', 'profiles_update'), ('public', 'profiles', 'profiles_select'), ('public', 'members', 'members_select'))) then
    raise exception 'no se puede deshacer 20261125100000_account_setup: otra funcion o politica nombra las ayudas o las columnas de esta migracion; borrarlas la romperia; revise el orden de los deshacer';
  end if;
end $$;

-- 1. El disparador del cambio de correo y su función.
drop trigger forbid_email_change on auth.users;
drop function app.forbid_email_change();

-- 2. Las políticas vuelven a su texto anterior (antes de borrar `app.session_alive()`, que las nombra).
alter policy profiles_update on public.profiles
  using (user_id = (select auth.uid()) and not (select app.second_step_pending()))
  with check (user_id = (select auth.uid()) and not (select app.second_step_pending()));

alter policy members_select on public.members
  using (
    (user_id = (select auth.uid()) and not (select app.second_step_pending()))
    or (tenant_id = (select app.current_tenant_id())
        and (status = 'active' or (select app.can('team.manage'))))
  );
alter policy profiles_select on public.profiles
  using (
    (user_id = (select auth.uid()) and not (select app.second_step_pending()))
    or user_id in (select app.current_tenant_people())
  );

-- 3. Las funciones vuelven EXACTAMENTE a su definición anterior (20261112100000_mfa_session_gate; `handle_new_user`, 20261001120400_legal).
create or replace function app.current_tenant_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_headers text := nullif(current_setting('request.headers', true), '');
  v_raw     text;
  v_tid     uuid;
begin
  if app.second_step_pending() then
    return null;
  end if;
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
    and not app.second_step_pending()
$$;

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
  if app.second_step_pending() then
    raise exception 'second_step_required' using errcode = '42501';
  end if;
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
  if app.second_step_pending() then
    raise exception 'second_step_required' using errcode = '42501';
  end if;
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
  if app.second_step_pending() then
    raise exception 'second_step_required' using errcode = '42501';
  end if;
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

create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name     text;
  v_accepted jsonb;
  v_doc      record;
begin
  v_name := left(coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Usuario'
  ), 120);

  insert into public.profiles (user_id, full_name) values (new.id, v_name);

  begin
    v_accepted := new.raw_user_meta_data -> 'accepted_legal';
    if jsonb_typeof(v_accepted) = 'object' then
      for v_doc in
        select d.id, d.kind from public.legal_documents d
        where d.is_current and (v_accepted ->> d.kind) = d.version
      loop
        insert into public.legal_acceptances (user_id, document_id, context)
        values (new.id, v_doc.id, 'signup')
        on conflict (user_id, document_id) do nothing;
      end loop;
    end if;
  exception when others then
    null;   -- un metadato mal formado no debe impedir el registro
  end;
  return new;
end $$;

-- 4. Se borran las ayudas y las funciones nuevas.
drop function public.complete_account_setup(text, text, text);
drop function public.account_setup_preflight(text, text, text);
drop function public.my_account_ready();
drop function app.account_setup_verdict(uuid, uuid, text, text, text, boolean);
drop function app.setup_denied(uuid, text);
drop function app.account_ready(uuid);
drop function app.session_from_email_link();
drop function app.session_alive();

-- 5. La lista de alcances del límite de intentos vuelve a la de 20261113100000 (se borran antes los contadores del alcance nuevo).
delete from public.auth_rate_limits where scope = 'signup_email';
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant',
                   'share_ip', 'share_token', 'share_respond_ip', 'quote_send_user',
                   'intake_read_ip', 'intake_submit_ip', 'intake_submit_ip_day', 'intake_submit_form',
                   'invite_accept_user', 'invite_link_ip',
                   'mfa_verify_user', 'mfa_verify_user_day', 'mfa_code_used',
                   'mfa_annul_ip', 'mfa_annul_token'));

-- 6. Las dos columnas (la restricción se va con `signup_email`). SE PIERDE «qué cuentas están terminadas» y el correo de alta.
alter table public.profiles drop column account_ready_at, drop column signup_email;
