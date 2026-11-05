-- Deshace 20261105100000_invitation_preview_read_only.sql
-- Devuelve `app.invitation_state` y `public.invitation_preview` a sus definiciones de
-- 20261103100000_invitation_accept.sql, con las mismas firmas y los mismos permisos. No toca datos.
--   · `app.invitation_state` vuelve a responder el estado (usada, cancelada, vencida, archivada, quien invitó ya no
--     puede) ANTES de comparar el correo.
--   · `public.invitation_preview` vuelve a contar fallos por cuenta, a tomar el candado por cuenta y a escribir
--     `invitation.accept_denied` al ver la pantalla de correo equivocado.
-- («Ver arriba» en los comentarios remite a esa migración.)
create or replace function app.invitation_state(i public.invitations, p_user_id uuid, p_email text) returns text
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
