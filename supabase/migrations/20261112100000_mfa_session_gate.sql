-- Sprint 5 · H-004a · Verificación en dos pasos · decisión D1-B de Aarón: la base de datos TAMBIÉN exige el segundo paso
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261112100000_mfa_session_gate.down.sql
-- Especificación: plan de H-004a (docs/arquitectura/sprint-5-equipo-y-permisos.md §5b y el registro de construcción de H-004a).
--
-- El problema: la aplicación detiene a quien ingresó solo con la contraseña (sesión «parcial», pase aal1) cuando su cuenta
-- tiene la verificación en dos pasos activa. Pero la dirección de Supabase y su llave pública NO son secretas: con la
-- contraseña, alguien puede pedir un pase aal1 directo a `/auth/v1/token` y leer o escribir por `/rest/v1/...` poniendo la
-- cabecera de la organización, saltándose la pantalla del código. Esta migración cierra ese camino en la base.
--
-- Qué cambia:
--   1. `app.second_step_pending()` (nueva): verdadero si la cuenta tiene un factor VERIFICADO en `auth.mfa_factors` y el pase
--      NO es aal2. Primero mira el nivel del pase (barato) y solo si no es aal2 busca el factor: quien ya pasó el segundo
--      paso casi no paga nada. Quien NO tiene factor tiene un pase aal1, así que en cada consulta se busca en
--      `auth.mfa_factors` (con índice por `user_id`; el costo es bajo, pero se paga). Una cuenta sin factor, o con un
--      factor sin verificar, se comporta exactamente igual que antes.
--   2. `app.current_tenant_id()`: al inicio, si el segundo paso está pendiente devuelve null. Todo lo que cuelga de ella (las
--      políticas de cada tabla, `current_member_role`, `has_role`, `can`, las funciones públicas) deja de ver y de escribir.
--      El resto del cuerpo es la copia LITERAL de 20261001120200_tenants_profiles_members.sql (la vigente).
--   3. `app.my_tenant_ids()`: agrega `and not app.second_step_pending()`: con la sesión parcial el selector de
--      organizaciones queda vacío. El resto es la copia LITERAL de la misma migración.
--   4. Política `members_select` (de 20261105110000_member_management.sql): su rama «las filas propias» (`user_id = auth.uid()`)
--      sigue leyéndose por la API aunque `my_tenant_ids()` y `current_tenant_id()` devuelvan nada, y mostraría a una sesión
--      parcial en qué organizaciones está y con qué rol. Se le agrega `and not app.second_step_pending()` a esa rama; la otra
--      rama (la organización activa) ya queda cerrada por `current_tenant_id()`. DESVIACIÓN DEL PLAN (que solo nombraba las dos
--      funciones): se encontró al probar «la sesión parcial ve 0 filas» y se cerró por ser el lado seguro.
--   5. Las puertas que usan `auth.uid()` SIN pasar por la organización activa (ronda 1 de correcciones, revisiones del 2026-11-11):
--      con el segundo paso pendiente (contraseña sola) tampoco se puede crear una organización, ver o aceptar una invitación,
--      aceptar los términos, leer o cambiar el propio perfil ni leer las propias aceptaciones. Funciones: `public.create_tenant`,
--      `public.accept_invitation`, `public.invitation_preview` y `public.accept_current_legal_documents` (copias LITERALES de
--      la definición vigente: 20261001140100, 20261109120000, 20261105100000 y 20261001120400, con SOLO tres líneas nuevas (el `if`) al
--      principio del cuerpo: `if app.second_step_pending() then raise exception 'second_step_required' using errcode =
--      '42501'; end if;`; en `accept_invitation` va antes del candado por cuenta y del conteo de intentos). Políticas:
--      `profiles_select` (rama propia), `profiles_update` (using y with check) y `legal_acceptances_select` (una condición más
--      `and not (select app.second_step_pending())`).
--
--   6. Alcances nuevos del límite de intentos (`auth_rate_limits`): `mfa_verify_user` (fallos por cuenta cada 15 min),
--      `mfa_verify_user_day` (fallos por cuenta en el día) y `mfa_code_used` (un mismo código no sirve dos veces). Sus
--      claves son huellas de «alcance|cuenta», nunca el correo, la IP ni el código.
--
-- Lo que NO cambia (a propósito): `app.effective_role()` (el rol bajado a Observador para quien no tiene factor es H-004c).
-- `legal_documents` se lee con y sin sesión (es público). Una cuenta sin factor, o con un factor sin verificar, se comporta
-- exactamente igual que antes en todo lo anterior.
--
-- Rendimiento: las políticas llaman a `current_tenant_id()` una vez por consulta (`(select app.current_tenant_id())`) y esa
-- llama a la función nueva; además otras ayudas (`my_tenant_ids()`, las funciones públicas) la llaman, así que una petición
-- puede hacerlo varias veces. Cada llamada hace como mucho una búsqueda por el índice de `auth.mfa_factors` (`user_id`), y
-- solo si el pase no es aal2: quien no tiene factor (pase aal1) la paga siempre, quien ya pasó el segundo paso casi nunca.
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia `set local lock_timeout = '3s'` y, justo después, la
-- verificación de que el valor quedó puesto.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261112100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

-- 1. ¿Falta el segundo paso? ---------------------------------------------------------------------------------------------
create function app.second_step_pending() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2'
     and exists (select 1 from auth.mfa_factors f
                 where f.user_id = auth.uid() and f.status = 'verified')
$$;
-- `authenticated` debe poder ejecutarla: la nombra una política (`members_select`), que corre con el rol de quien consulta.
-- Solo dice si la propia sesión está a medias; `app` no está expuesta por la API (config.toml: schemas = public).
revoke all on function app.second_step_pending() from public, anon;
grant execute on function app.second_step_pending() to authenticated;

-- 2. Organización activa: con el segundo paso pendiente no hay organización -----------------------------------------------
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

-- 3. Organizaciones de la persona (selector): con el segundo paso pendiente, ninguna ----------------------------------------
create or replace function app.my_tenant_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.tenant_id from public.members m
  where m.user_id = auth.uid() and m.status = 'active'
    and not app.second_step_pending()
$$;

-- 4. Las filas propias de `members` tampoco se leen con el segundo paso pendiente ------------------------------------------
alter policy members_select on public.members
  using (
    (user_id = (select auth.uid()) and not (select app.second_step_pending()))
    or (tenant_id = (select app.current_tenant_id())
        and (status = 'active' or (select app.can('team.manage'))))
  );

-- 5. Perfil y aceptaciones propias: tampoco con el segundo paso pendiente -------------------------------------------------
alter policy profiles_select on public.profiles
  using (
    (user_id = (select auth.uid()) and not (select app.second_step_pending()))
    or user_id in (select app.current_tenant_people())
  );
alter policy profiles_update on public.profiles
  using (user_id = (select auth.uid()) and not (select app.second_step_pending()))
  with check (user_id = (select auth.uid()) and not (select app.second_step_pending()));
alter policy legal_acceptances_select on public.legal_acceptances
  using (user_id = (select auth.uid()) and not (select app.second_step_pending()));

-- 6. Las cuatro funciones públicas con `auth.uid()` y sin organización --------------------------------------------------------
-- Copias literales de la definición vigente de cada una + la línea del segundo paso. Los permisos se conservan al reemplazarlas.

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

create or replace function public.accept_current_legal_documents() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_headers json := nullif(current_setting('request.headers', true), '')::json;
  v_ip      inet;
  v_count   integer;
begin
  if app.second_step_pending() then
    raise exception 'second_step_required' using errcode = '42501';
  end if;
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

-- 7. Alcances nuevos del límite de intentos ------------------------------------------------------------------------------
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant',
                   'share_ip', 'share_token', 'share_respond_ip', 'quote_send_user',
                   'intake_read_ip', 'intake_submit_ip', 'intake_submit_ip_day', 'intake_submit_form',
                   'invite_accept_user', 'invite_link_ip',
                   'mfa_verify_user', 'mfa_verify_user_day', 'mfa_code_used'));
