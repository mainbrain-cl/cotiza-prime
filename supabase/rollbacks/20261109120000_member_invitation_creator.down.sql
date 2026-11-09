-- Deshace 20261109120000_member_invitation_creator.sql
-- Devuelve `accept_invitation` a la definición de 20261109100000_invitation_accept_sender.sql (mismas firmas, mismos
-- permisos) y borra la columna `members.invitation_created_by`. El dato que tenía se pierde de `members`, pero sigue en
-- `invitations.invited_by` (por `member_id`) y en la auditoría `invitation.accepted` (`created_by`).
-- Orden: se niega a correr (1) si la función vigente `public.accept_invitation` ya no nombra `invitation_created_by`
-- (otra migración la redefinió o ya se deshizo: la versión que este archivo repone lee `invitations.resent_by`, y si esa
-- columna ya no existe toda aceptación válida fallaría), y (2) si otra función (aparte de `accept_invitation`, que este mismo archivo devuelve)
-- usa la columna: primero hay que deshacer lo que la use. Si se deshace también 20261109100000, este archivo va PRIMERO.
-- Salida si alguien corrió antes el deshacer de D3 (que no tiene guarda): este archivo se niega, y en PRUEBAS basta con
-- `alter table public.members drop column invitation_created_by;` a mano (el dato sigue en `invitations.invited_by` y en la
-- auditoría `invitation.accepted`).
set local lock_timeout = '3s';

do $$ begin
  if not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'accept_invitation' and p.prosrc ~ '\minvitation_created_by\M') then
    raise exception 'no se puede deshacer 20261109120000_member_invitation_creator: la funcion public.accept_invitation vigente ya no nombra invitation_created_by: otra migracion la redefinio o ya se deshizo; revise el orden de los deshacer';
  end if;
end $$;

do $$ declare v_users text; begin
  select string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', '
                      order by n.nspname, p.proname) into v_users
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app') and p.prosrc ~ '\minvitation_created_by\M'
     and n.nspname || '.' || p.proname <> 'public.accept_invitation';
  if v_users is not null then
    raise exception 'no se puede deshacer 20261109120000_member_invitation_creator: % todavia usa members.invitation_created_by. Deshaga antes las migraciones posteriores que la usan', v_users;
  end if;
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
           joined_at = now(), invited_by = v_sender
     where tenant_id = v_inv.tenant_id and id = v_member.id;
    v_member_id := v_member.id;
    v_role := v_inv.role;
    v_reactivated := true;
  else
    insert into public.members (tenant_id, user_id, role, status, invited_by)
    values (v_inv.tenant_id, v_uid, v_inv.role, 'active', v_sender)
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
revoke all on function public.accept_invitation(text) from public, anon, authenticated;
grant execute on function public.accept_invitation(text) to authenticated;

alter table public.members drop column if exists invitation_created_by;
