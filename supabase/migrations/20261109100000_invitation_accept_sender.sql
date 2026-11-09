-- Sprint 5 · H-010 · Corrección D3 y menores 1 y 2 de la revisión de Aarón al PR #33 (2026-11-09)
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261109100000_invitation_accept_sender.down.sql
-- Especificación: docs/arquitectura/sprint-5-equipo-y-permisos.md, «Corrección D3 y menores de la revisión de Aarón
-- (2026-11-09)».
--
-- Qué pidió Aarón:
--   · D3. Si un Administrador (X) reenvía una invitación del Dueño y la ata al correo de un cómplice, y el cómplice acepta
--     antes de que quiten a X, la membresía del cómplice quedaba a nombre del Dueño en `members.invited_by`: el desvío
--     solo lo delataba la auditoría. Ahora `members.invited_by` guarda a quien envió el enlace por última vez
--     (`coalesce(resent_by, invited_by)`), y la auditoría `invitation.accepted` anota `created_by` (quien creó la
--     invitación) y `sent_by` (quien envió el enlace aceptado).
--   · Menor 1. La limpieza `app.reconcile_invitation_senders` rellenaba `resent_by` con `is distinct from`: con dos correos
--     con el mismo `created_at`, el desempate podía pisar un `resent_by` correcto al repetir la limpieza, y al quitar a
--     quien reenvió la invitación ya no se cancelaba (reabría el ataque). Ahora rellena solo donde `resent_by` es nulo.
--   · Menor 2. El desempate de la limpieza (`e.id` descendente) no coincidía con el de `resend_invitation` (`e.id`
--     ascendente). La limpieza adopta el de `resend_invitation`, que no se toca: así los dos eligen el mismo correo.
--
-- Qué hace esta migración (dos funciones; cada una es copia literal de su versión anterior con las líneas indicadas):
--   1. `accept_invitation`: copia de 20261103100000_invitation_accept.sql con: `v_sender` en el `declare`; `v_sender` se
--      calcula justo después de comprobar que el estado es `ok`; la membresía nueva y la reactivada guardan
--      `invited_by = v_sender`; la auditoría suma `created_by` y `sent_by`. La respuesta a quien acepta no cambia. Esto
--      deja sin efecto la frase «`accept_invitation` no cambia» de 20261106100000_invitation_resender.sql.
--   2. `app.reconcile_invitation_senders`: copia de 20261106100000_invitation_resender.sql con dos cambios (menores 1 y 2).
--      Sigue sin ser `security definer` y sin que la ejecute nadie con un pase.
--
-- Qué NO hace: no rellena miembros que ya aceptaron (no hay producción; quedan como estaban), no llama a la limpieza, no
-- toca `resend_invitation`, `invitation_state` ni `invitation_preview`, y no cambia ninguna tabla ni permiso.
--
-- Orden de bloqueos: esta migración no bloquea tablas. `accept_invitation` conserva su orden (candado por cuenta,
-- invitación `for update`, después la fila de `members`).

-- 1. accept_invitation: queda a nombre de quien envió el enlace por última vez (D3) ------------------------------------
-- result: igual que antes (accepted · unverified · rate_limited · not_found · wrong_email · revoked · inviter_inactive ·
-- expired · used · archived). Las líneas nuevas llevan `v_sender`, `created_by` o `sent_by`.
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

-- 2. Limpieza: rellena solo donde `resent_by` es nulo, y con el mismo desempate que `resend_invitation` ------------------
create or replace function app.reconcile_invitation_senders() returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_backfilled integer;
  v_cancelled  integer;
begin
  lock table public.members in share mode;
  lock table public.invitations in access exclusive mode;

  update public.invitations i
     set resent_by = last_mail.created_by
    from (select distinct on (e.tenant_id, e.invitation_id) e.tenant_id, e.invitation_id, e.created_by
            from public.email_messages e
           where e.kind = 'invitation' and e.invitation_id is not null
           order by e.tenant_id, e.invitation_id, e.created_at desc, e.id) last_mail
   where i.status = 'pending' and i.send_count > 1
     and last_mail.tenant_id = i.tenant_id and last_mail.invitation_id = i.id
     and last_mail.created_by is not null
     and i.resent_by is null;
  get diagnostics v_backfilled = row_count;

  update public.invitations i
     set status = 'revoked', revoked_at = now(), revoked_by = null, revoke_reason = 'inviter_removed',
         owner_notice_state = case when i.owner_notice_state = 'pending' then 'none' else i.owner_notice_state end
   where i.status = 'pending'
     and not app.invitation_senders_ok(i.tenant_id, i.role::text, i.invited_by, i.resent_by);
  get diagnostics v_cancelled = row_count;

  return jsonb_build_object('backfilled', v_backfilled, 'cancelled', v_cancelled);
end $$;
revoke all on function app.reconcile_invitation_senders() from public, anon, authenticated;
