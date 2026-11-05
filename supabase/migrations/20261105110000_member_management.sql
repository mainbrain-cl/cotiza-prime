-- Sprint 5 · H-010 · Cambiar el rol de un miembro o quitarlo
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261105110000_member_management.down.sql
-- Especificación: docs/arquitectura/sprint-5-equipo-y-permisos.md §4 («Quitar a alguien») y §5 («Reglas de seguridad»).
--
-- Qué agrega:
--   · `public.list_members()`: los miembros ACTIVOS de la organización activa, con su correo (sale de `auth.users`).
--     Solo para quien maneja el equipo (`team.manage`): la lista con correos es de Dueño y Administradores.
--   · `public.change_member_role(p_member_id, p_new_role, p_expected_role)`: cambia el rol de un miembro activo.
--   · `public.remove_member(p_member_id, p_expected_role)`: quita a un miembro (cambia su estado a «quitado»; la
--     fila NO se borra, así sus cotizaciones siguen mostrando su nombre).
--   · `app.cancel_member_invitations(...)`: ayuda interna que cancela las invitaciones pendientes que envió una
--     persona (al quitarla, o al bajarla de un rol que maneja el equipo).
--   · `profiles_select`: se puede leer el NOMBRE de cualquier persona con una fila en `members` de la organización
--     activa, esté activa o quitada, para que las cotizaciones de quien se fue sigan mostrando su nombre como autor.
--     De `profiles` quedan legibles SOLO `user_id`, `tenant_id` y `full_name` (se quitan `created_at` y `updated_at`).
--   · `members_select`: las filas de quien ya se fue (con `removed_at` y `removed_by`) solo las lee quien maneja el
--     equipo; el resto del equipo sigue viendo las filas activas y las propias (sección 8).
--   · `create_invitation` y `resend_invitation` (H-008) bloquean la fila de miembro de quien invita o reenvía, para
--     que una invitación en curso no escape a la cancelación de `remove_member` / `change_member_role`, y solo el
--     Dueño invita o reenvía una invitación con un rol que maneja el equipo (ver abajo).
--
-- SOLO EL DUEÑO da o quita un rol que maneja el equipo (decisión por defecto aplicada por Aarón el 2026-11-05): si el
-- rol actual del miembro o el rol nuevo maneja el equipo (`team.manage`), quien actúa tiene que ser el Dueño (el rol
-- con `tenant.transfer`). Así un Administrador no puede invitar a alguien como Observador (sin aviso al Dueño) y
-- después subirlo a Administrador, ni bajar o quitar a otro Administrador.
-- LO MISMO AL INVITAR (decisión por defecto aplicada por Aarón el 2026-11-05, segunda revisión): solo el Dueño llama
-- `create_invitation` o `resend_invitation` sobre una invitación cuyo rol maneja el equipo; si no, `42501 owner_only`.
-- Cierra dos caminos que quedaban abiertos:
--   (a) `resend_invitation` guarda el vínculo de correo que manda quien llama (sha256 de «huella del código | correo»,
--       sin secreto). Un Administrador podía llamarla directo sobre una invitación a Administrador hecha por el Dueño,
--       con el vínculo del correo de un cómplice y un código suyo: el cómplice entraba como Administrador y, como
--       quien invitó era el Dueño, no se anotaba ningún aviso.
--   (b) un Administrador podía invitar directo a un Administrador; el aviso al Dueño quedaba solo anotado, y en
--       producción nadie lo envía mientras no se resuelva la decisión #17 (cómo se programa la tarea de avisos).
-- Los Administradores siguen invitando, reenviando y cancelando invitaciones con roles que NO manejan el equipo:
-- redirigir una de esas a otro correo no es peor que invitar directo.
--
-- Nadie escribe directo en `members` (sigue sin permisos de escritura para `authenticated`): solo estas funciones,
-- `create_tenant` y `accept_invitation`.
--
-- Códigos de error (SQLSTATE) y motivo (el texto del mensaje). Los fallos se LANZAN: el tope de cambios en el equipo
-- se cuenta en la auditoría (filas de cambios que SÍ se hicieron), así que un fallo no tiene conteo que perder.
--   42501  forbidden                   no maneja el equipo (o dejó de manejarlo mientras esperaba el candado)
--   42501  owner_only                  el miembro tiene, o recibiría, un rol que maneja el equipo y quien actúa no es
--                                      el Dueño (en `create_invitation` / `resend_invitation`: el rol de la
--                                      invitación maneja el equipo y quien invita o reenvía no es el Dueño)
--   CP404  not_found                   no es miembro de la organización activa (o no hay organización activa)
--   CP404  member_not_found            ese miembro no existe en ESTA organización (o ya no está activo, al cambiar su rol)
--   CP409  role_changed                el rol del miembro cambió desde que la persona abrió la pantalla
--   CP422  invalid_arguments           falta un argumento
--   CP422  invalid_role                el rol nuevo no existe o no se puede dar (el Dueño no se asigna jamás)
--   CP423  cannot_target_owner         nadie toca al Dueño (el traspaso es otra historia, H-111)
--   CP423  cannot_target_self          nadie se cambia el rol ni se quita a sí mismo
--   CP429  limit_member_changes        quien actúa ya hizo `app.member_change_max_per_hour()` cambios en esta
--                                      organización en la última hora (cambios de rol y quitadas, sumados)
-- Resultados (no son error): changed · unchanged (ya tenía ese rol) · removed (con `assigned_requests`: cuántas
-- solicitudes quedaron asignadas a esa persona, esperando que alguien las reasigne) · already_removed.
--
-- Orden de revisiones (para no revelar nada a quien no corresponde):
--   1. ¿es miembro de la organización activa?        no → CP404 not_found
--   2. ¿maneja el equipo?                            no → 42501 forbidden
--   3. forma de los argumentos y rol nuevo           → CP422
--   4. ¿el miembro es de ESTA organización?          no → CP404 member_not_found   (uno de otra organización da lo mismo)
--   5. ¿es la propia persona?                        → CP423 cannot_target_self
--   6. se bloquean las filas del miembro y de quien actúa, SIEMPRE por orden de id, y se vuelve a comprobar que quien
--      actúa sigue activo y sigue manejando el equipo (el Dueño quita a un Administrador mientras este quita a otra
--      persona: gana el primero)
--   7. ¿es el Dueño?                                 → CP423 cannot_target_owner
--   8. ¿ya está hecho?  ya tenía ese rol → `unchanged` · ya estaba quitado → `already_removed` (sin cambios ni
--      registro). Va ANTES de `owner_only`, para que una pantalla vieja reciba el mensaje cierto. No revela nada: quien
--      llega aquí sigue manejando el equipo de ESTA organización (comprobado sobre su fila ya bloqueada), así que ya ve
--      los roles en `list_members()` y las filas de quien se fue en `members`; y no cambia nada.
--   9. ¿el rol actual (o el nuevo) maneja el equipo y quien actúa no es el Dueño?  → 42501 owner_only
--      (sobre las filas YA bloqueadas: si el Dueño sube a alguien a Administrador mientras un Administrador lo cambia o
--      lo quita, el Administrador ve el rol nuevo y recibe `owner_only`)
--  10. el rol esperado coincide con el real          no → CP409 role_changed
--  11. el tope por hora, cambios de rol y quitadas sumados → CP429 limit_member_changes
--
-- No se escribe ningún nombre de rol entre comillas: todo se decide con la matriz (`app.can`, `app.role_can`), por la
-- guardia 14 de tests/db/schema-guards.test.ts.
--
-- ORDEN DE BLOQUEOS (descarta interbloqueos). Las funciones de esta migración y las dos de H-008 que se corrigen aquí
-- toman los bloqueos siempre en este orden, y nunca vuelven hacia atrás:
--   remove_member / change_member_role : filas de `members` del miembro y de quien actúa (`for update`, por orden de
--                                        id) → filas de `invitations` de ese miembro (`app.cancel_member_invitations`)
--   create_invitation / resend_invitation : fila de `members` de quien invita o reenvía (`for share`) → candado de
--                                        organización `invitations:<tenant>` (advisory) → filas de `invitations`
--                                        (`owner_only` se decide con el rol de esa fila de `members` ya bloqueada)
--   revoke_invitation                  : candado de organización → fila de `invitations`
-- Por qué no hay ciclo:
--   · `create_invitation` / `resend_invitation` toman su fila de `members` ANTES de cualquier otra cosa, así que mientras
--     esperan una fila de `members` no sostienen ningún otro bloqueo. Si `remove_member` o `change_member_role` ya
--     tienen esa fila (`for update` choca con `for share`), la espera es limpia; al despertar se vuelve a evaluar la
--     condición sobre la fila ya cambiada y, si la persona ya no está activa o ya no maneja el equipo, falla con 42501.
--   · Quien sostiene el candado de organización nunca pide después una fila de `members` (solo inserta o bloquea filas
--     de `invitations`), así que `remove_member` jamás espera a alguien que a su vez la espere a ella.
--   · `remove_member` / `change_member_role` pasan por `members` antes que por `invitations`; las funciones de
--     invitaciones pasan por el candado de organización antes que por `invitations`: ninguna toma `invitations`
--     antes de `members`, salvo `accept_invitation` (H-009, no se toca aquí): bloquea la invitación y después la fila
--     de `members` de quien acepta. Cruzarse con `remove_member` exigiría que quien acepta sea justo quien actúa o
--     el quitado; la base lo resolvería cortando una de las dos con error (sin dañar datos).
--   · Con la fila de quien invita bloqueada en modo compartido, la cancelación de `remove_member` ya no puede dejar
--     escapar una invitación en curso: o la invitación se guardó antes (y la cancelación la ve), o `create_invitation`
--     espera y falla con 42501.

-- 1. Ayuda: cancelar las invitaciones pendientes de una persona -----------------------------------------
-- Las invitaciones que envió alguien que se va (o que ya no maneja el equipo) dejan de valer: si no, su enlace
-- seguiría sumando gente en su nombre. `inviter_removed` es el motivo que `app.invitation_state` (H-009) ya entiende.
-- Una invitación cancelada no genera aviso al Dueño: si había uno por enviar, sale de la cola (como `revoke_invitation`).
create function app.cancel_member_invitations(p_tenant uuid, p_user uuid, p_by uuid) returns integer
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

-- Tope de cambios en el equipo por persona, por organización y por hora: cambios de rol y quitadas SUMADOS. Contra el
-- abuso (llenar el registro de actividad subiendo y bajando a alguien sin parar, o vaciar el equipo de una vez), no
-- contra el uso normal: ordenar un equipo entero cabe de sobra.
create function app.member_change_max_per_hour() returns integer language sql immutable as $$ select 30 $$;
revoke all on function app.member_change_max_per_hour() from public, anon, authenticated;

-- ¿Quien actúa ya llegó al tope? Cuenta en la auditoría los cambios que YA hizo en esta organización en la última hora
-- (`member.role_changed` y `member.removed`, con el índice `audit_tenant_actor`). Quien la llama tiene bloqueada la
-- fila de `members` de quien actúa (`for update`), así que dos cambios suyos a la vez no pasan el tope juntos.
create function app.member_changes_exhausted(p_tenant uuid, p_actor uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select count(*) >= app.member_change_max_per_hour()
    from public.audit_log a
   where a.tenant_id = p_tenant and a.actor_user_id = p_actor
     and a.action in ('member.role_changed', 'member.removed')
     and a.occurred_at > now() - interval '1 hour'
$$;
revoke all on function app.member_changes_exhausted(uuid, uuid) from public, anon, authenticated;

-- 2. list_members -----------------------------------------------------------------------------------------
-- Una lista (jsonb) de los miembros activos: el Dueño primero y después por fecha de ingreso. Solo para quien maneja
-- el equipo. El correo sale de la cuenta (`auth.users`), nunca se copia a otra tabla.
create function public.list_members() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_uid    uuid := auth.uid();
begin
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  if not app.can('team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'member_id', m.id,
               'user_id', m.user_id,
               'full_name', nullif(btrim(p.full_name), ''),
               'email', u.email,
               'role', m.role,
               'joined_at', m.joined_at,
               'is_self', m.user_id = v_uid)
             order by app.role_can(m.role, 'tenant.transfer') desc, m.joined_at, m.id)
      from public.members m
      join auth.users u on u.id = m.user_id
      left join public.profiles p on p.user_id = m.user_id
     where m.tenant_id = v_tenant and m.status = 'active'), '[]'::jsonb);
end $$;
revoke all on function public.list_members() from public, anon, authenticated;
grant execute on function public.list_members() to authenticated;

-- 3. change_member_role ------------------------------------------------------------------------------------
-- p_expected_role: el rol que la persona vio en pantalla. Si el rol real ya es otro, no se cambia nada
-- (CP409 role_changed): evita pisar el cambio de otra persona sin enterarse.
-- result: changed (con `cancelled_invitations`) · unchanged (el miembro ya tenía ese rol: no se audita nada)
create function public.change_member_role(p_member_id uuid, p_new_role text, p_expected_role text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant      uuid := app.current_tenant_id();
  v_uid         uuid := auth.uid();
  v_new         app.invitation_role;
  v_target_user uuid;
  v_actor_id    uuid;
  v_row         public.members;
  v_actor       public.members;
  v_target      public.members;
  v_cancelled   integer := 0;
begin
  -- 1. ¿es miembro de la organización activa?
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  -- 2. ¿maneja el equipo?
  if not app.can('team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 3. argumentos y rol nuevo (el Dueño no está entre los roles que se pueden dar)
  if p_member_id is null or p_new_role is null or p_expected_role is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  begin
    v_new := p_new_role;
  exception when check_violation then
    raise exception 'invalid_role' using errcode = 'CP422';
  end;
  -- 4. el miembro se busca SIEMPRE dentro de la organización activa
  select m.user_id into v_target_user
    from public.members m where m.tenant_id = v_tenant and m.id = p_member_id;
  if not found then
    raise exception 'member_not_found' using errcode = 'CP404';
  end if;
  -- 5. nadie se toca a sí mismo (así un Administrador no puede ascenderse ni quitarse)
  if v_target_user = v_uid then
    raise exception 'cannot_target_self' using errcode = 'CP423';
  end if;

  -- 6. dos cambios al mismo tiempo: se bloquean las filas del miembro Y de quien actúa, siempre por orden de id
  --    (así dos personas que se tocan mutuamente no se esperan para siempre) y se vuelve a comprobar todo.
  select m.id into v_actor_id
    from public.members m where m.tenant_id = v_tenant and m.user_id = v_uid and m.status = 'active';
  for v_row in
    select * from public.members m
     where m.tenant_id = v_tenant and m.id in (p_member_id, v_actor_id)
     order by m.id
       for update
  loop
    if v_row.id = p_member_id then v_target := v_row; end if;
    if v_row.id = v_actor_id then v_actor := v_row; end if;
  end loop;
  if v_actor.id is null or v_actor.status <> 'active' or not app.role_can(v_actor.role, 'team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_target.id is null or v_target.status <> 'active' then
    raise exception 'member_not_found' using errcode = 'CP404';
  end if;
  -- 7. nadie toca al Dueño
  if app.role_can(v_target.role, 'tenant.transfer') then
    raise exception 'cannot_target_owner' using errcode = 'CP423';
  end if;
  -- 8. Ya tiene ese rol: el resultado que se quería ya está. No cambia nada ni deja registro. Va antes de `owner_only`
  --    (una pantalla vieja recibe el mensaje cierto) y no revela nada: quien actúa maneja el equipo de esta
  --    organización y ya ve el rol de cada miembro activo en `list_members()`.
  if v_target.role = v_new::text then
    return jsonb_build_object('result', 'unchanged', 'member_id', v_target.id, 'role', v_target.role);
  end if;
  -- 9. un rol que maneja el equipo solo lo da o lo quita el Dueño (con los roles de las filas YA bloqueadas).
  if (app.role_can(v_target.role, 'team.manage') or app.role_can(v_new::text, 'team.manage'))
     and not app.role_can(v_actor.role, 'tenant.transfer') then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  -- 10. solo si el rol sigue siendo el que la persona vio
  if v_target.role is distinct from p_expected_role then
    raise exception 'role_changed' using errcode = 'CP409';
  end if;
  -- 11. tope por hora: cambios de rol y quitadas de esta persona en esta organización, sumados (su registro de
  --     auditoría). Su fila de `members` está bloqueada desde el paso 6, así que dos cambios suyos a la vez no pasan
  --     el tope juntos. «Ya tenía ese rol» no deja registro y no cuenta.
  if app.member_changes_exhausted(v_tenant, v_uid) then
    raise exception 'limit_member_changes' using errcode = 'CP429';
  end if;

  update public.members set role = v_new where tenant_id = v_tenant and id = v_target.id;
  -- Si el rol nuevo ya no maneja el equipo, las invitaciones que esa persona envió dejan de valer.
  if app.role_can(v_target.role, 'team.manage') and not app.role_can(v_new::text, 'team.manage') then
    v_cancelled := app.cancel_member_invitations(v_tenant, v_target.user_id, v_uid);
  end if;
  perform app.write_audit(v_tenant, 'user', v_uid, 'member.role_changed', 'member', v_target.id, 'success',
    jsonb_build_object('old_role', v_target.role, 'new_role', v_new::text, 'cancelled_invitations', v_cancelled));
  return jsonb_build_object('result', 'changed', 'member_id', v_target.id, 'role', v_new::text,
                            'cancelled_invitations', v_cancelled);
end $$;
revoke all on function public.change_member_role(uuid, text, text) from public, anon, authenticated;
grant execute on function public.change_member_role(uuid, text, text) to authenticated;

-- 4. remove_member -------------------------------------------------------------------------------------------
-- Quita a un miembro: pasa a «quitado» con cuándo y quién. NO se borra nada de lo que hizo (cotizaciones,
-- solicitudes asignadas, borradores). Desde su siguiente petición ya no es miembro: `app.current_tenant_id()` exige
-- el estado activo, así que aunque su pase de sesión siga vigente ve cero filas y toda función le responde «prohibido».
-- result: removed (con `cancelled_invitations` y `assigned_requests`) · already_removed (repetir no falla ni deja
-- otro registro). `assigned_requests`: cuántas solicitudes siguen asignadas a esa persona (estado «asignada»); NO se
-- tocan: quedan a su nombre hasta que el Dueño o un Administrador las reasigne. La pantalla lo dice al terminar.
-- Tiene el mismo tope por hora que `change_member_role`, sumado con él (`limit_member_changes`).
create function public.remove_member(p_member_id uuid, p_expected_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant      uuid := app.current_tenant_id();
  v_uid         uuid := auth.uid();
  v_target_user uuid;
  v_actor_id    uuid;
  v_row         public.members;
  v_actor       public.members;
  v_target      public.members;
  v_cancelled   integer;
  v_assigned    integer;
begin
  if v_tenant is null or v_uid is null then
    raise exception 'not_found' using errcode = 'CP404';
  end if;
  if not app.can('team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_member_id is null or p_expected_role is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select m.user_id into v_target_user
    from public.members m where m.tenant_id = v_tenant and m.id = p_member_id;
  if not found then
    raise exception 'member_not_found' using errcode = 'CP404';
  end if;
  if v_target_user = v_uid then
    raise exception 'cannot_target_self' using errcode = 'CP423';
  end if;

  select m.id into v_actor_id
    from public.members m where m.tenant_id = v_tenant and m.user_id = v_uid and m.status = 'active';
  for v_row in
    select * from public.members m
     where m.tenant_id = v_tenant and m.id in (p_member_id, v_actor_id)
     order by m.id
       for update
  loop
    if v_row.id = p_member_id then v_target := v_row; end if;
    if v_row.id = v_actor_id then v_actor := v_row; end if;
  end loop;
  if v_actor.id is null or v_actor.status <> 'active' or not app.role_can(v_actor.role, 'team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_target.id is null then
    raise exception 'member_not_found' using errcode = 'CP404';
  end if;
  if app.role_can(v_target.role, 'tenant.transfer') then
    raise exception 'cannot_target_owner' using errcode = 'CP423';
  end if;
  -- Ya estaba quitado (otra persona lo quitó antes): el resultado que se quería ya está. Va antes de `owner_only`, para
  -- que una pantalla vieja reciba el mensaje cierto; no revela nada: quien actúa maneja el equipo de esta organización
  -- y ya lee las filas de quien se fue (`members_select`, sección 8). No cambia nada ni deja registro.
  if v_target.status = 'removed' then
    return jsonb_build_object('result', 'already_removed', 'member_id', v_target.id);
  end if;
  -- A quien maneja el equipo solo lo quita el Dueño (con los roles de las filas YA bloqueadas).
  if app.role_can(v_target.role, 'team.manage') and not app.role_can(v_actor.role, 'tenant.transfer') then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if v_target.role is distinct from p_expected_role then
    raise exception 'role_changed' using errcode = 'CP409';
  end if;
  -- Tope por hora, el mismo de `change_member_role` y sumado con él: sin esto un Administrador podía sacar de una vez
  -- a todos los Comerciales y Aprobadores sin que nadie lo frene. «Ya estaba quitado» no deja registro y no cuenta.
  if app.member_changes_exhausted(v_tenant, v_uid) then
    raise exception 'limit_member_changes' using errcode = 'CP429';
  end if;

  update public.members
     set status = 'removed', removed_at = now(), removed_by = v_uid
   where tenant_id = v_tenant and id = v_target.id;
  v_cancelled := app.cancel_member_invitations(v_tenant, v_target.user_id, v_uid);
  select count(*)::integer into v_assigned
    from public.intake_requests r
   where r.tenant_id = v_tenant and r.assigned_to = v_target.user_id and r.status = 'assigned';
  perform app.write_audit(v_tenant, 'user', v_uid, 'member.removed', 'member', v_target.id, 'success',
    jsonb_build_object('role', v_target.role, 'cancelled_invitations', v_cancelled));
  return jsonb_build_object('result', 'removed', 'member_id', v_target.id, 'cancelled_invitations', v_cancelled,
                            'assigned_requests', v_assigned);
end $$;
revoke all on function public.remove_member(uuid, text) from public, anon, authenticated;
grant execute on function public.remove_member(uuid, text) to authenticated;

-- 5. El nombre de quien se fue sigue visible para su organización --------------------------------------------
-- Antes solo se leía el perfil de los miembros ACTIVOS: al quitar a alguien, sus cotizaciones mostraban «—» como
-- autor. Ahora se lee el de cualquiera con una fila en `members` de la organización activa (activa o quitada).
-- Solo salen las columnas legibles de `profiles`: `user_id`, `tenant_id` y `full_name` (la sección 7 quita
-- `created_at` y `updated_at`); nunca el correo, que no está en `profiles`.
-- Quien fue quitado sigue sin poder leer nada de la organización: `app.current_tenant_id()` le da null.
-- Ley 21.719: que una cotización muestre a su autor es un registro legítimo de la organización; si esa persona pide
-- suprimir su cuenta (H-109), su nombre pasa a «Ex miembro». Aquí no se copia ningún nombre ni correo a otras tablas.
-- Las personas se buscan con una ayuda `security definer` y no con una consulta a `members` dentro de la política:
-- desde la sección 8, `members` solo le muestra las filas de quien se fue a quien maneja el equipo, y el Observador
-- tiene que seguir leyendo el nombre del autor de una cotización. La ayuda entrega solo identificadores de cuenta de
-- la organización activa (los mismos que `profiles` ya deja leer), nunca `removed_at` ni `removed_by`.
create function app.current_tenant_people() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.user_id from public.members m where m.tenant_id = app.current_tenant_id()
$$;
revoke all on function app.current_tenant_people() from public, anon;
grant execute on function app.current_tenant_people() to authenticated;

alter policy profiles_select on public.profiles
  using (
    user_id = (select auth.uid())
    or user_id in (select app.current_tenant_people())
  );

-- 6. Quien invita o reenvía tiene que seguir siendo miembro con permiso mientras lo hace ------------------------
-- `create_invitation` y `resend_invitation` (H-008), idénticas a las de `20261030100000_invitations.sql` salvo por
-- el bloqueo de la fila de miembro de quien actúa y la regla «solo el Dueño, si el rol maneja el equipo» (marcados
-- «H-010»). El deshacer restaura las originales.
create or replace function public.create_invitation(
  p_invitation_id uuid, p_email_enc text, p_email_hash text, p_email_binding text, p_token_sha256 text,
  p_role text, p_email_message_id uuid, p_to_email_enc text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant  uuid := app.current_tenant_id();
  v_uid     uuid := auth.uid();
  v_role    app.invitation_role;
  v_actor_role text;
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

  -- H-010: la fila de miembro de QUIEN INVITA se bloquea (en modo compartido) ANTES del candado de la organización y
  --    se comprueba aquí que sigue activo y con permiso. Sin esto, si lo quitan o le bajan el rol mientras invita,
  --    `app.cancel_member_invitations` (que corre dentro de `remove_member` / `change_member_role`) no ve las
  --    invitaciones que todavía no se guardaron y esas quedan «pendientes». Ver el orden de bloqueos en el encabezado.
  select m.role into v_actor_role from public.members m
   where m.tenant_id = v_tenant and m.user_id = v_uid and m.status = 'active'
     and app.role_can(m.role, 'team.manage')
     for share;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- H-010: una invitación con un rol que maneja el equipo solo la hace el Dueño (con el rol de la fila YA bloqueada).
  --    Antes del candado y de los topes: no se espera ni se cuenta nada para una invitación que no se va a crear.
  if app.role_can(v_role::text, 'team.manage') and not app.role_can(v_actor_role, 'tenant.transfer') then
    raise exception 'owner_only' using errcode = '42501';
  end if;

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
       -- sin pasar por la pantalla, la tarea lo enviará (ver 7b). H-010: con la regla `owner_only` de arriba ya no
       -- se cumple para una invitación nueva (solo el Dueño invita a un rol que maneja el equipo); se deja como
       -- defensa por si esa regla cambia.
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

-- 7. De `profiles`, solo el nombre ------------------------------------------------------------------------------
-- La regla de arriba deja LEER a los compañeros de la organización, pero la migración 12 concedía además `created_at` y
-- `updated_at`: `updated_at` cambia cada vez que la persona cambia de organización, así que una organización podría
-- ver cuándo un ex miembro usa la plataforma en otra empresa. Quedan legibles `user_id`, `tenant_id` y `full_name`;
-- `last_tenant_id` sigue cerrada como antes (migración 12). Nada del código lee esas dos columnas.
revoke select (created_at, updated_at) on public.profiles from authenticated;

-- 8. Las filas de quien se fue, solo para quien maneja el equipo ------------------------------------------------
-- Antes cualquier miembro (también el Observador) leía por la API todas las filas de `members` de la organización,
-- incluidas las de quienes ya se fueron con cuándo (`removed_at`) y quién los quitó (`removed_by`). Ahora:
--   · las filas propias, como antes (el selector de organizaciones y `app.current_tenant_id()` las necesitan);
--   · las filas ACTIVAS de la organización activa, para todos (todos ven a su equipo: decisión 009);
--   · las filas de quien se fue, solo con `team.manage` (Dueño y Administradores; el registro de actividad del
--     Dueño las usa para decir a quién afectó cada cambio).
-- Nadie del código lee una fila quitada sin ese permiso: las solicitudes y las cotizaciones filtran `status =
-- 'active'`, el registro de actividad es solo del Dueño y el nombre del autor sale de `profiles` (sección 5). Las
-- funciones de la base son `security definer` y no pasan por esta política.
alter policy members_select on public.members
  using (
    user_id = (select auth.uid())
    or (tenant_id = (select app.current_tenant_id())
        and (status = 'active' or (select app.can('team.manage'))))
  );
