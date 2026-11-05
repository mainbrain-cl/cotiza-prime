-- Deshace 20261105110000_member_management.sql
-- Borra las tres funciones de H-010 y sus ayudas (cancelar invitaciones, el tope de cambios de rol y las personas de la
-- organización activa), devuelve `profiles_select` a la regla de antes (solo el nombre de los miembros ACTIVOS) y
-- `members_select` a la de la migración 2 (todas las filas de la organización activa, para cualquier miembro). No toca miembros ni invitaciones: lo que ya se quitó o canceló queda así (el estado de `members`
-- y de `invitations` es de las historias anteriores). Las filas de auditoría `member.role_changed` y `member.removed`
-- se conservan (la auditoría es de solo agregar).
-- Las dos funciones de H-008 vuelven a su definición original (sin el bloqueo de la fila de quien invita).
create or replace function public.create_invitation(
  p_invitation_id uuid, p_email_enc text, p_email_hash text, p_email_binding text, p_token_sha256 text,
  p_role text, p_email_message_id uuid, p_to_email_enc text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant  uuid := app.current_tenant_id();
  v_uid     uuid := auth.uid();
  v_role    app.invitation_role;
  v_pending uuid;
  v_expires timestamptz := now() + make_interval(days => app.invitation_ttl_days());
begin
  -- 1. ¿es miembro de la organización activa?
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  -- 2. ¿puede manejar el equipo?
  if not app.can('team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 3. forma de lo recibido y rol permitido (el Dueño no se invita)
  if p_invitation_id is null or p_email_message_id is null or p_role is null
     or p_email_enc is null or char_length(p_email_enc) not between 1 and 2000
     or p_to_email_enc is null or char_length(p_to_email_enc) not between 1 and 2000
     or p_email_hash is null or p_email_hash !~ '^[0-9a-f]{64}$'
     or p_email_binding is null or p_email_binding !~ '^[0-9a-f]{64}$'
     or p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  begin
    v_role := p_role;
  exception when check_violation then
    raise exception 'invalid_role' using errcode = 'CP422';
  end;

  -- 4. topes, contados con un candado por organización: dos invitaciones a la vez no pasan el tope juntas.
  perform pg_advisory_xact_lock(hashtextextended('invitations:' || v_tenant::text, 0));
  if (select count(*) from public.invitations i
       where i.tenant_id = v_tenant and i.invited_by = v_uid
         and i.created_at > now() - interval '1 hour') >= app.invitation_max_per_user_hour() then
    raise exception 'limit_user_hour' using errcode = 'CP429';
  end if;
  if (select count(*) from public.invitations i
       where i.tenant_id = v_tenant and i.created_at > now() - interval '1 day') >= app.invitation_max_per_tenant_day() then
    raise exception 'limit_tenant_day' using errcode = 'CP429';
  end if;
  if (select count(*) from public.invitations i
       where i.tenant_id = v_tenant and i.status = 'pending' and i.expires_at > now()) >= app.invitation_max_pending() then
    raise exception 'limit_pending' using errcode = 'CP429';
  end if;

  -- 5. ¿ya es miembro activo de ESTA organización? Se compara el vínculo con el de cada miembro activo; así
  --    jamás se consulta un correo que no sea de esta organización.
  if exists (
    select 1
      from public.members m join auth.users u on u.id = m.user_id
     where m.tenant_id = v_tenant and m.status = 'active' and u.email is not null
       and app.invitation_binding(p_token_sha256, u.email) = p_email_binding) then
    return jsonb_build_object('result', 'already_member');
  end if;

  -- 6. ¿ya tiene una invitación pendiente (vencida o no)? Se ofrece reenviarla.
  select i.id into v_pending from public.invitations i
   where i.tenant_id = v_tenant and i.email_hash = p_email_hash and i.status = 'pending';
  if found then
    return jsonb_build_object('result', 'already_pending', 'invitation_id', v_pending);
  end if;

  -- 7. crear
  begin
    insert into public.invitations
      (id, tenant_id, email_enc, email_hash, email_binding, role, token_sha256, status, expires_at, invited_by,
       owner_notice_state)
    values
      (p_invitation_id, v_tenant, p_email_enc, p_email_hash, p_email_binding, v_role, p_token_sha256,
       'pending', v_expires, v_uid,
       -- El aviso al Dueño queda anotado AQUÍ, en la misma operación: aunque alguien llame la función directo,
       -- sin pasar por la pantalla, la tarea lo enviará (ver 7b).
       case when app.invitation_notice_applies(v_role, v_uid, v_tenant) then 'pending' else 'none' end);
    insert into public.email_messages
      (id, tenant_id, invitation_id, kind, to_email_enc, to_email_hash, provider, status, created_by)
    values
      (p_email_message_id, v_tenant, p_invitation_id, 'invitation', p_to_email_enc, p_email_hash,
       'pending', 'pending', v_uid);
  exception when unique_violation then
    -- Otra invitación pendiente para el mismo correo ganó la carrera.
    select i.id into v_pending from public.invitations i
     where i.tenant_id = v_tenant and i.email_hash = p_email_hash and i.status = 'pending';
    if found then
      return jsonb_build_object('result', 'already_pending', 'invitation_id', v_pending);
    end if;
    raise exception 'id_in_use' using errcode = 'CP422';
  end;
  -- `notify_owner`: la pantalla intentará el aviso al Dueño de inmediato. La garantía no es ese intento sino la
  -- tarea: el aviso ya quedó anotado como pendiente. Un fallo del aviso nunca deshace la invitación.
  return jsonb_build_object('result', 'created', 'invitation_id', p_invitation_id,
                            'email_message_id', p_email_message_id, 'expires_at', v_expires,
                            'notify_owner', app.invitation_notice_applies(v_role, v_uid, v_tenant));
end $$;

create or replace function public.resend_invitation(
  p_invitation_id uuid, p_email_binding text, p_token_sha256 text, p_email_message_id uuid, p_to_email_enc text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant  uuid := app.current_tenant_id();
  v_uid     uuid := auth.uid();
  v_inv     public.invitations;
  v_mail    public.email_messages;
  v_expires timestamptz := now() + make_interval(days => app.invitation_ttl_days());
begin
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  if not app.can('team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_invitation_id is null or p_email_message_id is null
     or p_to_email_enc is null or char_length(p_to_email_enc) not between 1 and 2000
     or p_email_binding is null or p_email_binding !~ '^[0-9a-f]{64}$'
     or p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invitations:' || v_tenant::text, 0));
  select * into v_inv from public.invitations i where i.tenant_id = v_tenant and i.id = p_invitation_id for update;
  if not found then
    raise exception 'invitation_not_found' using errcode = 'CP404';
  end if;
  if v_inv.status <> 'pending' then
    raise exception 'not_pending' using errcode = 'CP423';
  end if;
  if v_inv.send_count - 1 >= app.invitation_max_resends() then
    raise exception 'limit_resends' using errcode = 'CP429';
  end if;
  -- Reenviar una vencida la deja vigente otra vez: cuenta para el tope de pendientes igual que invitar.
  if v_inv.expires_at <= now()
     and (select count(*) from public.invitations i
           where i.tenant_id = v_tenant and i.status = 'pending' and i.expires_at > now())
         >= app.invitation_max_pending() then
    raise exception 'limit_pending' using errcode = 'CP429';
  end if;
  select * into v_mail from public.email_messages e
   where e.tenant_id = v_tenant and e.invitation_id = v_inv.id and e.kind = 'invitation'
   order by e.created_at desc, e.id limit 1;
  if v_inv.last_sent_at > now() - make_interval(mins => app.invitation_resend_min_minutes())
     and not (found and (v_mail.status = 'failed'
                         or (v_mail.status = 'pending'
                             and v_mail.created_at < now() - make_interval(mins => app.invitation_mail_grace_minutes())))) then
    raise exception 'resend_too_soon' using errcode = 'CP429';
  end if;

  begin
    update public.invitations
       set token_sha256 = p_token_sha256, email_binding = p_email_binding, expires_at = v_expires,
           send_count = v_inv.send_count + 1, last_sent_at = now()
     where tenant_id = v_tenant and id = v_inv.id;
    insert into public.email_messages
      (id, tenant_id, invitation_id, kind, to_email_enc, to_email_hash, provider, status, created_by)
    values
      (p_email_message_id, v_tenant, v_inv.id, 'invitation', p_to_email_enc, v_inv.email_hash,
       'pending', 'pending', v_uid);
  exception when unique_violation then
    raise exception 'id_in_use' using errcode = 'CP422';
  end;
  perform app.write_audit(v_tenant, 'user', v_uid, 'invitation.resent', 'invitation', v_inv.id, 'success',
    jsonb_build_object('role', v_inv.role, 'send_count', v_inv.send_count + 1));
  return jsonb_build_object('result', 'resent', 'invitation_id', v_inv.id, 'email_message_id', p_email_message_id,
                            'expires_at', v_expires, 'send_count', v_inv.send_count + 1);
end $$;

-- `profiles` vuelve a conceder `created_at` y `updated_at` (migración 12).
grant select (created_at, updated_at) on public.profiles to authenticated;

-- Las políticas primero: `profiles_select` usa `app.current_tenant_people()`, que se borra después.
alter policy profiles_select on public.profiles
  using (
    user_id = (select auth.uid())
    or user_id in (
      select m.user_id from public.members m
      where m.tenant_id = (select app.current_tenant_id()) and m.status = 'active'
    )
  );
alter policy members_select on public.members
  using (user_id = (select auth.uid()) or tenant_id = (select app.current_tenant_id()));

drop function if exists public.remove_member(uuid, text);
drop function if exists public.change_member_role(uuid, text, text);
drop function if exists public.list_members();
drop function if exists app.cancel_member_invitations(uuid, uuid, uuid);
drop function if exists app.member_role_change_max_per_hour();
drop function if exists app.current_tenant_people();
