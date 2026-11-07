-- Sprint 5 · H-010 · Corrección de la revisión del 2026-11-06 · las invitaciones que REENVIÓ quien se va también se cancelan
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261106100000_invitation_resender.down.sql
-- Especificación: docs/arquitectura/sprint-5-equipo-y-permisos.md, «Corrección: invitaciones reenviadas (revisión del
-- 2026-11-06)».
--
-- El problema: al quitar a un Administrador (o bajarlo a un rol que no maneja el equipo), H-010 cancelaba solo las
-- invitaciones pendientes con `invited_by` = esa persona. Pero `resend_invitation` cambia el código y el vínculo de
-- correo de la invitación (a quién queda atada) sin anotar quién la reenvió, y al aceptar o mirar el estado solo se
-- exigía que quien la CREÓ siguiera con permiso. Ataque: el Administrador X, sabiendo que lo van a quitar, llama directo
-- a la base, reenvía una invitación pendiente de Comercial que hizo el Dueño (u otro Administrador) y la ata al correo
-- de un cómplice. Lo quitan: la limpieza no la cancela (no es suya). El cómplice acepta y entra como Comercial.
--
-- Qué hace esta migración:
--   1. Bloquea `members` (compartido) e `invitations` (exclusivo), en ese orden, el mismo de `remove_member`.
--   2. `invitations.resent_by`: quién reenvió por última vez (nulo = nunca se reenvió). Nadie con un pase la lee.
--   3. `app.invitation_sender_ok` / `app.invitation_senders_ok`: ¿quien envió (y quien reenvió) sigue pudiendo?
--      Además, una invitación a un rol que maneja el equipo solo vale si quien la creó y la reenvió es el Dueño
--      (decisión D2: cierra el camino que `owner_only` ya cerraba al crear o reenviar, también para las que quedaron
--      desviadas antes de esta migración).
--   4. `app.invitation_state` usa las ayudas (copia literal con un solo cambio).
--   5. `public.resend_invitation` anota `resent_by = quien reenvía` (copia literal con un solo cambio).
--   6. `app.cancel_member_invitations` cancela también las que esa persona reenvió.
--   7. `app.reconcile_invitation_senders()`: limpieza única y repetible; la migración la llama una vez al final.
--
-- Al desplegar: la migración ya llama una vez `select app.reconcile_invitation_senders();`. Si hubiera pendientes
-- reenviadas por alguien que ya no puede, quedan canceladas con el motivo `inviter_removed`. Se puede volver a correr
-- sin efecto.
--
-- Decisiones por defecto aplicadas (José, 2026-11-06; las revisa Aarón):
--   · Si sale quien CREÓ la invitación, se cancela aunque el Dueño la haya reenviado después (ya pasaba antes).
--   · Se reutiliza el motivo `inviter_removed`; no hay motivo nuevo.
--   · El relleno inicial de `resent_by` cubre solo las PENDIENTES; de las cerradas queda la auditoría `invitation.resent`.
--   · D3 (límite conocido): si el cómplice ya aceptó ANTES de que quiten a X, se acepta y no se deshace: X podía meter a
--     esa persona invitándola él mismo (con un rol que no maneja el equipo), y queda a la vista en «Tu equipo».
--     `accept_invitation` no cambia.
--
-- No se escribe ningún nombre de rol entre comillas: todo se decide con la matriz (`app.role_can`), por la guardia 14 de
-- tests/db/schema-guards.test.ts.
--
-- ORDEN DE BLOQUEOS. Las funciones de uso normal no cambian su orden. Esta migración y `app.reconcile_invitation_senders()`
-- toman `members` y después `invitations`, como `remove_member`. `accept_invitation` (H-009) va en orden contrario: si
-- coincide con la migración, la base corta una de las dos con un error, sin dañar datos.

-- 1. Bloqueos -------------------------------------------------------------------------------------------------------
do $$ begin
  lock table public.members in share mode;
  lock table public.invitations in access exclusive mode;
end $$;

-- 2. Quién reenvió por última vez -----------------------------------------------------------------------------------
-- Nulo = nunca se reenvió (así las filas que se insertan directo en las pruebas siguen sirviendo). Sin permiso de
-- lectura para `authenticated`: el `grant select` de la tabla es por columnas y esta no está en la lista.
alter table public.invitations add column resent_by uuid references auth.users (id);
comment on column public.invitations.resent_by is
  'Quien reenvió por última vez (nulo = nunca se reenvió). Si deja de poder manejar el equipo, la invitación se cancela.';
create index invitations_tenant_resender on public.invitations (tenant_id, resent_by)
  where status = 'pending' and resent_by is not null;

-- 3. ¿Quien envió, y quien reenvió, siguen pudiendo? ----------------------------------------------------------------
-- Sí si tiene una fila ACTIVA en esa organización con un rol que maneja el equipo (`team.manage`) y, si el rol de la
-- invitación también maneja el equipo, además es el Dueño (`tenant.transfer`).
create function app.invitation_sender_ok(p_tenant uuid, p_role text, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.members m
     where m.tenant_id = p_tenant and m.user_id = p_user and m.status = 'active'
       and app.role_can(m.role, 'team.manage')
       and (not app.role_can(p_role, 'team.manage') or app.role_can(m.role, 'tenant.transfer')))
$$;
revoke all on function app.invitation_sender_ok(uuid, text, uuid) from public, anon, authenticated;

-- Quien creó la invitación y, si la reenvió alguien, quien la reenvió por última vez: las dos personas tienen que seguir
-- pudiendo.
create function app.invitation_senders_ok(p_tenant uuid, p_role text, p_invited_by uuid, p_resent_by uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.invitation_sender_ok(p_tenant, p_role, p_invited_by)
         and (p_resent_by is null or app.invitation_sender_ok(p_tenant, p_role, p_resent_by))
$$;
revoke all on function app.invitation_senders_ok(uuid, text, uuid, uuid) from public, anon, authenticated;

-- 4. app.invitation_state: también mira a quien reenvió -------------------------------------------------------
-- COPIA LITERAL de la definición de 20261105100000_invitation_preview_read_only.sql con UN solo cambio: la revisión de
-- «quien invitó sigue pudiendo» pasa a `app.invitation_senders_ok`. Sigue DESPUÉS de `wrong_email`: quien no es la
-- persona invitada recibe lo mismo y en el mismo tiempo (H-009).
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
  -- Corrección de la revisión del 2026-11-06: no basta quien CREÓ la invitación; también quien la REENVIÓ por última
  -- vez (`resent_by`) tiene que seguir en la organización y manejando el equipo (ver `app.invitation_senders_ok`).
  if not app.invitation_senders_ok(i.tenant_id, i.role::text, i.invited_by, i.resent_by) then
    return 'inviter_inactive';
  end if;
  return 'ok';
end $$;
revoke all on function app.invitation_state(public.invitations, uuid, text) from public, anon, authenticated;

-- 5. public.resend_invitation: guarda quién reenvía ------------------------------------------------------------
-- COPIA LITERAL de la definición de 20261105110000_member_management.sql con UN solo cambio: el `update` anota
-- `resent_by = v_uid`. Misma firma, mismos argumentos, mismos permisos (se conservan con `create or replace`).
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
           send_count = v_inv.send_count + 1, last_sent_at = now(),
           resent_by = v_uid   -- corrección de la revisión del 2026-11-06: quién reenvió por última vez
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

-- 6. app.cancel_member_invitations: también las que esa persona reenvió ---------------------------------------------
-- Misma firma y mismo motivo (`inviter_removed`). Una invitación que la persona creó Y reenvió cuenta una sola vez. El
-- aviso al Dueño que estuviera por enviarse sale de la cola, como antes.
create or replace function app.cancel_member_invitations(p_tenant uuid, p_user uuid, p_by uuid) returns integer
language sql volatile security definer set search_path = '' as $$
  with cancelled as (
    update public.invitations
       set status = 'revoked', revoked_at = now(), revoked_by = p_by, revoke_reason = 'inviter_removed',
           owner_notice_state = case when owner_notice_state = 'pending' then 'none' else owner_notice_state end
     where tenant_id = p_tenant and status = 'pending' and (invited_by = p_user or resent_by = p_user)
    returning 1)
  select count(*)::integer from cancelled
$$;
revoke all on function app.cancel_member_invitations(uuid, uuid, uuid) from public, anon, authenticated;

-- 7. Limpieza única y repetible ---------------------------------------------------------------------------------------
-- 1) bloquea `members` y después `invitations` (como `remove_member`); 2) rellena `resent_by` solo en las PENDIENTES con
-- más de un envío, con quien creó el último correo de invitación de cada una; 3) cancela las pendientes cuyo creador o
-- reenviador ya no pueden (igual que la sección 9 de H-010: `revoked`, `inviter_removed`, sin `revoked_by`, el aviso al
-- Dueño fuera de la cola; el disparador de auditoría deja un `invitation.updated` de `system` por fila). Cubre también
-- las invitaciones a Administrador que quedaron desviadas antes de H-010. Devuelve cuántas rellenó y cuántas canceló.
-- No es `security definer` y nadie con un pase puede ejecutarla: solo se llama desde la migración o con permisos de
-- administrador de la base.
create function app.reconcile_invitation_senders() returns jsonb
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
           order by e.tenant_id, e.invitation_id, e.created_at desc, e.id desc) last_mail
   where i.status = 'pending' and i.send_count > 1
     and last_mail.tenant_id = i.tenant_id and last_mail.invitation_id = i.id
     and last_mail.created_by is not null
     and i.resent_by is distinct from last_mail.created_by;
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

select app.reconcile_invitation_senders();
