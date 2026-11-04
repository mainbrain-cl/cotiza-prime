-- Sprint 5 · H-009 · Aceptar una invitación
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261103100000_invitation_accept.down.sql
-- Especificación: docs/arquitectura/sprint-5-equipo-y-permisos.md §2 («Flujo de H-009») y §5.
--
-- Qué agrega:
--   · `public.invitation_preview(p_token_sha256)`: lo que la pantalla de «Unirme» necesita mostrar (organización,
--     quién invita y rol). Solo para una persona CON SESIÓN. Si la invitación es para otro correo, no entrega
--     ni el nombre de la organización ni el de quien invitó.
--   · `public.accept_invitation(p_token_sha256)`: la persona entra a la organización. Corre con SU pase (jamás con
--     la llave maestra) y decide TODO dentro de la base: el rol sale de la invitación, nunca de la petición.
--   · Dos alcances nuevos en `auth_rate_limits`: `invite_accept_user` (aceptaciones fallidas por persona, 10 en
--     10 minutos, lo cuenta la propia base) e `invite_link_ip` (aperturas del enlace por IP, lo cuenta el
--     servidor en `/invitacion/[token]`).
--
-- Decisión 017: NINGUNA de estas funciones se abre a personas sin sesión. Solo `authenticated`.
--
-- Los fallos esperados (el código no existe, el correo no coincide, está cancelada, vencida…) se DEVUELVEN como
-- resultado y no se lanzan como error: un error deshace la transacción, y con ella el conteo de intentos
-- fallidos. Solo se lanza error cuando no hay sesión (42501), la transacción es de solo lectura (25006) o el
-- argumento no tiene forma de huella (CP422).
--
-- Solo lectura: PostgREST ejecuta un GET (`/rest/v1/rpc/...?...`) en una transacción de solo lectura, donde ni se
-- podría contar un fallo ni aceptar. Las dos funciones lo rechazan (25006) apenas comprueban la sesión, para que
-- nadie pruebe códigos por GET saltándose el límite de intentos. La aplicación las llama siempre con POST.
--
-- `accept_invitation` revisa EN ESTE ORDEN:
--   1. sesión (y que la transacción no sea de solo lectura) → 42501 · 25006
--   2. la huella tiene forma de huella                  → CP422
--   3. el correo de la cuenta está verificado           → `unverified`
--   4. la persona no está bloqueada por intentos        → `rate_limited`
--   5. busca la invitación por la huella y la BLOQUEA   → no existe: `not_found` (cuenta como fallo)
--   6. el estado (`app.invitation_state`):              → `revoked` · `inviter_inactive` · `expired` · `used` ·
--                                                          `archived`
--   7. el correo coincide con el vínculo guardado       → `wrong_email` (cuenta como fallo y queda en la
--                                                          auditoría de la organización de la invitación)
--   8. membresía: ya es miembro activo → se marca aceptada SIN tocar su rol; la quitaron antes → se reactiva su
--      fila con el rol de la invitación; si no, se crea.
--   9. la invitación pasa a `accepted` y se VACÍAN `email_enc`, `email_hash` y `email_binding`.
--
-- NO toca: las filas `invitation_notice` de `email_messages` ni `owner_notice_state` / `owner_notice_*` (el aviso
-- al Dueño tiene que poder salir aunque la invitación ya esté aceptada), ni las filas `invitation` de
-- `email_messages` (se borran 30 días después de aceptarse, por `app.purge_invitations()`).

-- 0. Constantes con nombre -------------------------------------------------------------------------
create function app.invitation_accept_max_failures()   returns integer language sql immutable as $$ select 10 $$;
create function app.invitation_accept_window_seconds() returns integer language sql immutable as $$ select 600 $$;
create function app.invitation_accept_lock_seconds()   returns integer language sql immutable as $$ select 600 $$;
revoke all on function
  app.invitation_accept_max_failures(), app.invitation_accept_window_seconds(), app.invitation_accept_lock_seconds()
  from public, anon, authenticated;

-- 1. Alcances nuevos del límite de intentos -----------------------------------------------------------
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant',
                   'share_ip', 'share_token', 'share_respond_ip', 'quote_send_user',
                   'intake_read_ip', 'intake_submit_ip', 'intake_submit_ip_day', 'intake_submit_form',
                   'invite_accept_user', 'invite_link_ip'));

-- La clave del contador: huella de «invite_accept_user|id de la cuenta». No es el correo ni la IP.
create function app.invitation_accept_key(p_user_id uuid) returns text
language sql immutable parallel safe set search_path = '' as $$
  select encode(sha256(convert_to('invite_accept_user|' || p_user_id::text, 'UTF8')), 'hex')
$$;

-- ¿Esta persona está bloqueada por demasiadas aceptaciones fallidas?
create function app.invitation_accept_locked(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.auth_limit_locked_until('invite_accept_user', app.invitation_accept_key(p_user_id)) is not null
$$;

-- Suma un fallo (código inexistente o correo que no coincide). Al llegar al máximo bloquea a la persona.
create function app.invitation_accept_fail(p_user_id uuid) returns void
language sql volatile security definer set search_path = '' as $$
  select public.auth_limit_record_failure(
    'invite_accept_user', app.invitation_accept_key(p_user_id),
    app.invitation_accept_max_failures(), app.invitation_accept_window_seconds(),
    app.invitation_accept_lock_seconds())
$$;
revoke all on function
  app.invitation_accept_key(uuid), app.invitation_accept_locked(uuid), app.invitation_accept_fail(uuid)
  from public, anon, authenticated;

-- 2. El estado de una invitación para esta persona --------------------------------------------------
-- Una sola definición para la vista previa y para aceptar, así nunca discrepan. Devuelve:
--   accepted_by_you · la aceptó ESTA persona y sigue siendo miembro activa (repetir el clic no falla)
--   used            · ya la aceptó otra persona (o esta, pero ya no es miembro)
--   revoked         · cancelada
--   inviter_inactive · quien invitó ya no está en la organización o ya no maneja el equipo (también si H-010 la
--                     canceló por eso: `revoke_reason = 'inviter_removed'`). La persona debe pedirle a OTRA persona
--                     de la organización que la invite de nuevo
--   expired         · pasó su vigencia
--   archived        · la organización ya no está activa
--   wrong_email     · el vínculo guardado no corresponde al correo de la cuenta
--   ok
-- El correo se compara con el vínculo que dejó H-008: sha256(huella del código | correo normalizado).
create function app.invitation_state(i public.invitations, p_user_id uuid, p_email text) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if i.status = 'accepted' then
    if i.accepted_by = p_user_id and exists (
         select 1 from public.members m
          where m.tenant_id = i.tenant_id and m.user_id = p_user_id and m.status = 'active') then
      return 'accepted_by_you';
    end if;
    return 'used';
  end if;
  if i.status = 'revoked' then
    return case when i.revoke_reason = 'inviter_removed' then 'inviter_inactive' else 'revoked' end;
  end if;
  if i.expires_at <= now() then
    return 'expired';
  end if;
  if not exists (
       select 1 from public.tenants t
        where t.tenant_id = i.tenant_id and t.status = 'active' and t.kind = 'organization') then
    return 'archived';
  end if;
  -- Si quien invitó ya no está en la organización (o ya no maneja el equipo), su invitación pendiente no vale:
  -- H-010 las cancelará al quitarlo o bajarlo de rol; esta revisión cubre el tiempo intermedio.
  if not exists (
       select 1 from public.members m
        where m.tenant_id = i.tenant_id and m.user_id = i.invited_by and m.status = 'active'
          and app.role_can(m.role, 'team.manage')) then
    return 'inviter_inactive';
  end if;
  if i.email_binding is null or i.email_binding is distinct from app.invitation_binding(i.token_sha256, p_email) then
    return 'wrong_email';
  end if;
  return 'ok';
end $$;
revoke all on function app.invitation_state(public.invitations, uuid, text) from public, anon, authenticated;

-- Deja en la auditoría de la organización de la invitación que alguien probó el código con otro correo.
-- Va SIN el correo ni el código: solo quién (la cuenta), a qué invitación y el motivo.
-- Por qué no inunda la auditoría: (1) solo se llama junto con `app.invitation_accept_fail`, es decir, nunca más de
-- 10 veces en 10 minutos por cuenta (después la cuenta queda bloqueada y la función ni llega aquí). Para que el tope
-- valga también con muchas peticiones SIMULTÁNEAS de una misma cuenta, las dos funciones toman un candado por cuenta
-- (`pg_advisory_xact_lock`) justo después de la guarda de solo lectura: las llamadas de una cuenta pasan en fila y la
-- segunda ya ve el fallo de la primera (sin el candado, la pregunta «¿está bloqueada?» solo ve lo ya confirmado y
-- 30 peticiones a la vez veían «no bloqueada», sumaban un fallo y escribían una fila cada una); (2) para llegar a esta
-- rama hay que conocer un código REAL (un código inventado da `not_found`, sin organización y sin registro);
-- (3) repartir los intentos entre muchas cuentas exige crearlas, y el registro tiene el tope por IP de la
-- APLICACIÓN (`signUpAction`); quien se registra llamando directo a `/auth/v1/signup` solo choca con el tope de
-- Supabase y con la confirmación del correo, que es el freno real. Los resultados se devuelven (no se lanzan), así
-- que el registro persiste aunque el intento haya fallado.
create function app.invitation_audit_wrong_email(i public.invitations, p_user_id uuid, p_step text) returns void
language sql volatile security definer set search_path = '' as $$
  select app.write_audit(i.tenant_id, 'user', p_user_id, 'invitation.accept_denied', 'invitation', i.id, 'denied',
    jsonb_build_object('reason', 'wrong_email', 'step', p_step))
$$;
revoke all on function app.invitation_audit_wrong_email(public.invitations, uuid, text) from public, anon, authenticated;

-- 3. invitation_preview ----------------------------------------------------------------------------------
-- Con sesión (y no de solo lectura). result: ok (con organización, quien invita, rol y vigencia; si ya eres miembro
-- activo, además `already_member` y tu `current_role`: aceptar no lo cambia) · accepted (ya eres miembro por esta
-- invitación; con la organización a la que entrar) · unverified · rate_limited · not_found · wrong_email ·
-- revoked · inviter_inactive · expired · used · archived. Solo `ok` y `accepted` entregan datos de la organización: para otro
-- correo, para una invitación cancelada, vencida o usada, no se revela nada de ella.
create function public.invitation_preview(p_token_sha256 text) returns jsonb
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
  -- Un GET de PostgREST corre en solo lectura: ahí no se podría contar un fallo, así que no se atiende (ver arriba).
  if current_setting('transaction_read_only') = 'on' then
    raise exception 'read_only' using errcode = '25006';
  end if;
  -- Un candado por cuenta, hasta el fin de la transacción: las llamadas de una misma cuenta pasan en fila, así que
  -- la pregunta «¿está bloqueada?» ve los fallos que otras llamadas simultáneas ya sumaron (ver arriba).
  perform pg_advisory_xact_lock(hashtextextended('invite_accept_user|' || v_uid::text, 0));
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
  if app.invitation_accept_locked(v_uid) then
    return jsonb_build_object('result', 'rate_limited');
  end if;
  select * into v_inv from public.invitations i where i.token_sha256 = p_token_sha256;
  if not found then
    perform app.invitation_accept_fail(v_uid);
    return jsonb_build_object('result', 'not_found');
  end if;
  v_state := app.invitation_state(v_inv, v_uid, v_email);
  if v_state = 'wrong_email' then
    perform app.invitation_accept_fail(v_uid);
    perform app.invitation_audit_wrong_email(v_inv, v_uid, 'preview');
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
revoke all on function public.invitation_preview(text) from public, anon, authenticated;
grant execute on function public.invitation_preview(text) to authenticated;

-- 4. accept_invitation ----------------------------------------------------------------------------------
-- result: accepted (con `tenant_id`, el `role` que la persona tiene en la organización, `already_member` si ya
-- lo era —su rol no cambió— y `reactivated` si la habían quitado antes) · unverified · rate_limited · not_found ·
-- wrong_email · revoked · inviter_inactive · expired · used · archived.
create function public.accept_invitation(p_token_sha256 text) returns jsonb
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
           joined_at = now(), invited_by = v_inv.invited_by
     where tenant_id = v_inv.tenant_id and id = v_member.id;
    v_member_id := v_member.id;
    v_role := v_inv.role;
    v_reactivated := true;
  else
    insert into public.members (tenant_id, user_id, role, status, invited_by)
    values (v_inv.tenant_id, v_uid, v_inv.role, 'active', v_inv.invited_by)
    returning id into v_member_id;
    v_role := v_inv.role;
  end if;

  -- 9. la invitación queda aceptada y el correo (dato personal) se borra: ya vive en la cuenta.
  update public.invitations
     set status = 'accepted', accepted_at = now(), accepted_by = v_uid, member_id = v_member_id,
         email_enc = null, email_hash = null, email_binding = null
   where tenant_id = v_inv.tenant_id and id = v_inv.id;

  perform app.write_audit(v_inv.tenant_id, 'user', v_uid, 'invitation.accepted', 'invitation', v_inv.id, 'success',
    jsonb_build_object('role', v_inv.role, 'already_member', v_already, 'reactivated', v_reactivated));
  return jsonb_build_object('result', 'accepted', 'tenant_id', v_inv.tenant_id, 'role', v_role,
                            'already_member', v_already, 'reactivated', v_reactivated);
end $$;
revoke all on function public.accept_invitation(text) from public, anon, authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
