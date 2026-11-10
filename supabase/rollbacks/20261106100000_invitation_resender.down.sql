-- Deshace 20261106100000_invitation_resender.sql
-- Devuelve `app.invitation_state` a la definición de 20261105100000_invitation_preview_read_only.sql, y
-- `public.resend_invitation` y `app.cancel_member_invitations` a las de 20261105110000_member_management.sql (mismas
-- firmas, mismos permisos); borra la limpieza (`app.reconcile_invitation_senders`), las dos ayudas
-- (`app.invitation_senders_ok`, `app.invitation_sender_ok`), el índice y la columna `invitations.resent_by`.
-- NO REVIVE las invitaciones que la migración canceló al aplicarse (no se sabe cuáles estaban pendientes antes y
-- revivirlas reabriría el camino que cerró): quedan `revoked` con `inviter_removed` y su auditoría. Si hace falta, se
-- invita de nuevo.
-- Orden: primero las funciones vuelven a su definición anterior (ya no usan las ayudas ni la columna), después se borran.
-- Orden entre migraciones: se niega a correr si alguna otra función todavía usa la columna `invitations.resent_by` (hoy
-- `accept_invitation`, desde 20261109100000): hay que deshacer antes, de la más nueva a la más antigua, las migraciones
-- posteriores que la usan. Sin esta revisión, `accept_invitation` quedaría leyendo una columna que ya no existe y toda
-- aceptación válida fallaría. La lista de excepciones es EXACTAMENTE lo que este archivo redefine o borra (seis funciones), nombradas por su firma completa (`to_regprocedure`) y no solo por el nombre, y la columna se busca sin distinguir mayúsculas.
-- (Pedido de Aarón en el PR #35. La excepción de «no editar lo ya integrado»: es un deshacer.)
do $$ declare v_users text; begin
  select string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', '
                      order by n.nspname, p.proname) into v_users
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app') and p.prosrc ~* '\mresent_by\M'
     and not exists (
       select 1 from unnest(array[
         'app.invitation_state(public.invitations, uuid, text)',
         'public.resend_invitation(uuid, text, text, uuid, text)',
         'app.cancel_member_invitations(uuid, uuid, uuid)',
         'app.reconcile_invitation_senders()',
         'app.invitation_senders_ok(uuid, text, uuid, uuid)',
         'app.invitation_sender_ok(uuid, text, uuid)']) as t(sig)
        where to_regprocedure(t.sig)::oid = p.oid);
  if v_users is not null then
    raise exception 'no se puede deshacer 20261106100000_invitation_resender: % todavia usa invitations.resent_by. Deshaga antes, de la mas nueva a la mas antigua, las migraciones posteriores que la usan (hoy, primero 20261109120000_member_invitation_creator.down.sql y despues 20261109100000_invitation_accept_sender.down.sql)', v_users;
  end if;
end $$;

create or replace function app.invitation_state(i public.invitations, p_user_id uuid, p_email text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  -- Quién pregunta, antes que nada, y SIEMPRE las dos comparaciones, sea cual sea el estado: calcular el vínculo
  -- (normalizar el correo + sha256) solo en las pendientes o canceladas haría que una aceptada respondiera
  -- `wrong_email` un poco antes, y quien no es la persona invitada podría medir esa diferencia repitiendo la vista
  -- previa para saber si la invitación ya se aceptó. Se calcula aparte (no dentro de un `and`) para que se calcule
  -- también cuando el vínculo está vacío.
  v_binding     text    := app.invitation_binding(i.token_sha256, p_email);
  v_bind_ok     boolean := i.email_binding is not null and i.email_binding is not distinct from v_binding;
  v_accepter_ok boolean := i.accepted_by is not distinct from p_user_id;
begin
  -- Una aceptada ya no guarda el vínculo del correo (se vació al aceptarla): la persona es la cuenta que la aceptó.
  if i.status = 'accepted' then
    if not v_accepter_ok then
      return 'wrong_email';
    end if;
    if exists (
         select 1 from public.members m
          where m.tenant_id = i.tenant_id and m.user_id = p_user_id and m.status = 'active') then
      return 'accepted_by_you';
    end if;
    return 'used';
  end if;
  -- Pendiente o cancelada: el vínculo sigue guardado (`invitations_email_shape`).
  if not v_bind_ok then
    return 'wrong_email';
  end if;
  -- Desde aquí, solo la persona invitada.
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
  return 'ok';
end $$;
revoke all on function app.invitation_state(public.invitations, uuid, text) from public, anon, authenticated;

create or replace function public.resend_invitation(
  p_invitation_id uuid, p_email_binding text, p_token_sha256 text, p_email_message_id uuid, p_to_email_enc text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant  uuid := app.current_tenant_id();
  v_uid     uuid := auth.uid();
  v_inv     public.invitations;
  v_mail    public.email_messages;
  v_actor_role text;
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

  -- H-010: la fila de miembro de QUIEN REENVÍA se bloquea (en modo compartido) ANTES del candado de la organización
  --    y se comprueba aquí que sigue activo y con permiso: así no sale un correo a nombre de alguien que ya lo
  --    quitaron o a quien le bajaron el rol. Ver el orden de bloqueos en el encabezado.
  select m.role into v_actor_role from public.members m
   where m.tenant_id = v_tenant and m.user_id = v_uid and m.status = 'active'
     and app.role_can(m.role, 'team.manage')
     for share;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invitations:' || v_tenant::text, 0));
  select * into v_inv from public.invitations i where i.tenant_id = v_tenant and i.id = p_invitation_id for update;
  if not found then
    raise exception 'invitation_not_found' using errcode = 'CP404';
  end if;
  if v_inv.status <> 'pending' then
    raise exception 'not_pending' using errcode = 'CP423';
  end if;
  -- H-010: una invitación con un rol que maneja el equipo solo la reenvía el Dueño (con el rol de su fila de `members`
  --    YA bloqueada). Reenviar guarda el vínculo de correo que manda quien llama, así que reenviar es, en la práctica,
  --    poder cambiar a quién va la invitación: sin esto un Administrador redirigía a un cómplice una invitación a
  --    Administrador hecha por el Dueño, sin aviso. Antes de los topes: no revela cuántos reenvíos quedan.
  if app.role_can(v_inv.role::text, 'team.manage') and not app.role_can(v_actor_role, 'tenant.transfer') then
    raise exception 'owner_only' using errcode = '42501';
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

create or replace function app.cancel_member_invitations(p_tenant uuid, p_user uuid, p_by uuid) returns integer
language sql volatile security definer set search_path = '' as $$
  with cancelled as (
    update public.invitations
       set status = 'revoked', revoked_at = now(), revoked_by = p_by, revoke_reason = 'inviter_removed',
           owner_notice_state = case when owner_notice_state = 'pending' then 'none' else owner_notice_state end
     where tenant_id = p_tenant and invited_by = p_user and status = 'pending'
    returning 1)
  select count(*)::integer from cancelled
$$;
revoke all on function app.cancel_member_invitations(uuid, uuid, uuid) from public, anon, authenticated;

drop function if exists app.reconcile_invitation_senders();
drop function if exists app.invitation_senders_ok(uuid, text, uuid, uuid);
drop function if exists app.invitation_sender_ok(uuid, text, uuid);
drop index if exists public.invitations_tenant_resender;
alter table public.invitations drop column if exists resent_by;
