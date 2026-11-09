-- Sprint 5 · H-010 · Menores 1 y 4 de la revisión de Aarón al PR #35 (2026-11-09): quién creó la invitación queda en el
-- miembro, y las migraciones esperan poco por un bloqueo.
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261109120000_member_invitation_creator.down.sql
-- Especificación: docs/arquitectura/sprint-5-equipo-y-permisos.md, «Menores del #35 (2026-11-09)».
--
-- Qué pidió Aarón:
--   · Menor 1. Hoy `members.invited_by` guarda a quien envió el enlace por última vez (D3). Si un Administrador crea la
--     invitación y el Dueño la reenvía, el miembro queda a nombre del Dueño; el Administrador solo se ve en
--     `invitations.invited_by` y en la auditoría (`created_by`). Conviene tenerlo también en el miembro.
--   · Menor 4. Antes de la primera ida a producción, las migraciones esperan un bloqueo un tiempo acotado (`lock_timeout`)
--     en vez de quedarse en la fila y frenar tras ellas toda la aplicación. Regla para esta migración y las que vengan:
--     la primera sentencia de cada migración y de cada deshacer con fecha desde 20261109120000 es
--     `set local lock_timeout = '3s'` (la comprueba la guardia 15 de tests/db/schema-guards.test.ts).
--
-- Qué hace esta migración:
--   1. Agrega `members.invitation_created_by` (uuid, nulable, sin valor por defecto, con referencia a `auth.users`, igual que
--      `invited_by`). Al ser nulable y sin valor por defecto, Postgres no reescribe la tabla.
--   2. `accept_invitation`: copia literal de 20261109100000_invitation_accept_sender.sql con tres cambios, todos en la parte
--      posterior al estado `ok`: la membresía reactivada y la nueva guardan `invitation_created_by = v_inv.invited_by`
--      (más un comentario). La respuesta a quien acepta, el tiempo de respuesta de H-009, el orden de bloqueos y
--      la auditoría (que ya anota `created_by` y `sent_by`) no cambian.
--
-- Qué NO hace: no rellena a los miembros que ya existen (quedan vacíos: no hay producción; el dato sigue en
-- `invitations.invited_by` por `member_id` y en la auditoría `invitation.accepted`), no cambia a quien ya era miembro
-- activo (no se toca nada de su fila), no agrega índices ni permisos (la única restricción es la referencia a `auth.users` de la columna nueva; `members` da lectura a toda la tabla
-- a los miembros activos de su organización: la columna la lee cualquier miembro activo por la API, igual que
-- `invited_by`), no cambia `list_members()` y no toca `invitation_state`, `invitation_preview`, `resend_invitation` ni la
-- limpieza. En una reactivación el valor anterior queda en la auditoría automática `member.updated`.
--
-- Bloqueos: la columna toma `access exclusive` sobre `members` (se consulta en cada petición) y, mientras sostiene ese,
-- `share row exclusive` sobre `auth.users` por la referencia, un instante. Por eso la primera sentencia fija `lock_timeout`:
-- si no consigue un bloqueo en 3 s, la migración falla sin cambiar nada y se reintenta. OJO: el tope vale POR CADA bloqueo
-- que se pide, no por migración. Aquí se piden dos seguidos, así que en el peor caso `members` queda detenida ~3 s esperando
-- el primero y otros ~3 s sosteniéndolo mientras se espera el de `auth.users` (casi 6 s en total, más que la espera de 5 s
-- de las pantallas); lo normal es mucho menos y, en la primera ida a producción, la base está vacía y sin tráfico (ver
-- modelo-datos.md §9.4). `set local` vale hasta el fin de la transacción de esta migración. `accept_invitation` conserva su orden de bloqueos (candado por cuenta, invitación `for update`, fila de
-- `members`).

set local lock_timeout = '3s';

alter table public.members add column invitation_created_by uuid references auth.users (id);
comment on column public.members.invitation_created_by is
  'Quién creó la invitación aceptada (invitations.invited_by). members.invited_by guarda a quien envió el enlace por última vez. Vacío para el Dueño que creó la organización y para quien entró antes de esta migración. No cambia si la persona ya era miembro activa.';

-- accept_invitation: guarda también a quien creó la invitación -----------------------------------------------------------
-- result: igual que antes (accepted · unverified · rate_limited · not_found · wrong_email · revoked · inviter_inactive ·
-- expired · used · archived). Las líneas nuevas llevan `invitation_created_by`.
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
revoke all on function public.accept_invitation(text) from public, anon, authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
