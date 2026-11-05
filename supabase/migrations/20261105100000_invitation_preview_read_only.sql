-- Sprint 5 · H-009 · Corrección I1 de la revisión adversarial · la vista previa de una invitación es SOLO LECTURA
-- y a quien NO es la persona invitada no le cuenta en qué estado está la invitación
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261105100000_invitation_preview_read_only.down.sql
-- Especificación: docs/arquitectura/sprint-5-equipo-y-permisos.md, «Corrección I1 de la revisión adversarial».
--
-- El problema: abrir `/invitacion` (una visita, un GET) llamaba a `public.invitation_preview`, que CONTABA fallos por
-- cuenta y escribía `invitation.accept_denied` en la auditoría. La cookie de sesión es `SameSite=Lax`, así que una
-- página ajena puede mandar a cualquier persona con sesión abierta a `/invitacion/<código>` sin que haga nada:
--   · Rastreo: con un código real de otra organización para otro correo, quedaba una fila en la auditoría de esa
--     organización con la cuenta de la víctima y su IP.
--   · Bloqueo: abriendo 11 códigos inventados, la cuenta de la víctima quedaba bloqueada 10 minutos y su invitación
--     legítima daba `rate_limited`.
--
-- 1. `invitation_preview` ya no cuenta fallos, no escribe auditoría y no toca ninguna tabla. SÍ lee el estado del
--    tope de la cuenta para devolver `rate_limited` si ya estaba bloqueada (leer no daña). Contar fallos y auditar
--    quedan SOLO en `accept_invitation` (el botón «Unirme», una acción de servidor = POST con revisión de origen).
--    Los códigos tienen 256 bits: contar los fallos de la vista previa no protegía nada real.
--    Qué NO cambia: la firma, los campos de cada resultado y los permisos (solo `authenticated`; `anon` y `public`
--    no la ejecutan). Sigue siendo `SECURITY DEFINER` con `search_path = ''`. Sigue rechazando una transacción de
--    solo lectura (25006), como `accept_invitation`: ya no hace falta para la vista previa, pero se mantiene para no
--    cambiar quién puede llamarla. Ya no toma el candado por cuenta (solo servía para contar).
--
-- 2. `app.invitation_state` compara PRIMERO quién pregunta (antes respondía el estado y recién al final comparaba
--    el correo). Antes, quien tenía el enlace de OTRA persona sabía si la invitación seguía pendiente, se había usado,
--    la habían cancelado, había vencido, la organización estaba archivada o quien invitó ya no podía invitar (era
--    M-2), y con la vista previa de solo lectura podía preguntarlo sin límite y sin dejar rastro. Ahora:
--      · aceptada: solo la cuenta que la aceptó (`accepted_by`) ve `accepted_by_you` o `used`;
--      · pendiente o cancelada (el vínculo del correo se guarda hasta aceptarla): solo la cuenta cuyo correo
--        corresponde al vínculo ve su estado;
--      · cualquier otra cuenta recibe `wrong_email`, SEA CUAL SEA el estado: la misma respuesta, sin más campos.
--    Como hay una sola definición, cambia también `accept_invitation`: una cuenta ajena recibe `wrong_email` en todos
--    los estados y por eso ese intento CUENTA como fallo y deja `invitation.accept_denied` (antes, con una
--    invitación ya cancelada, vencida o usada, la cuenta ajena recibía el estado sin contar ni dejar registro: era
--    el mismo oráculo, por POST). Para la persona invitada nada cambia.
--    Lo que queda: `not_found` (el código no existe: nunca existió, se reemplazó al reenviar o se borró 30 días
--    después de vencer o cancelarse) se distingue de `wrong_email`. Sin la fila no se puede saber quién es la
--    persona invitada, así que unirlos le diría «cambia de cuenta» a la invitada de un enlace viejo. Solo lo ve
--    quien ya tenía un código real, pero no es un solo bit: consultando cada día, CUÁNDO pasa a `not_found` dice si
--    se reenvió, venció, se canceló o (si nunca pasa) se aceptó. Es un límite conocido, anotado en M-2 del
--    documento del sprint con su arreglo posible; no se corrige aquí.
--    Para no abrir otra fuga por el tiempo de respuesta, `app.invitation_state` calcula SIEMPRE el vínculo del correo
--    y compara `accepted_by` antes de mirar el estado: una aceptada no responde `wrong_email` antes que una pendiente.
--
-- Consecuencia consciente: la pantalla «Cambia de cuenta para unirte» (correo equivocado) ya NO deja fila en la
-- auditoría al verse; solo la deja un intento real de aceptar (`accept_invitation`, motivo `wrong_email`).

-- 1. El estado de una invitación para esta persona (la misma firma, los mismos permisos) -------------------------
-- Devuelve (para la cuenta invitada o la que la aceptó):
--   accepted_by_you · la aceptó ESTA persona y sigue siendo miembro activa (repetir el clic no falla)
--   used            · la aceptó ESTA persona, pero ya no es miembro
--   revoked         · cancelada
--   inviter_inactive · quien invitó ya no está en la organización o ya no maneja el equipo (también si H-010 la
--                     canceló por eso: `revoke_reason = 'inviter_removed'`). La persona debe pedirle a OTRA persona
--                     de la organización que la invite de nuevo
--   expired         · pasó su vigencia
--   archived        · la organización ya no está activa
--   ok
-- y, para cualquier otra cuenta, SIEMPRE `wrong_email` (también si la aceptó otra persona).
-- El correo se compara con el vínculo que dejó H-008: sha256(huella del código | correo normalizado).
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

-- 2. invitation_preview: solo lectura --------------------------------------------------------------------------
-- result: ok (con organización, quien invita, rol y vigencia; si ya eres miembro activo, además `already_member` y tu
-- `current_role`) · accepted (con la organización a la que entrar) · unverified · rate_limited · not_found ·
-- wrong_email · y, solo para la persona invitada, revoked · inviter_inactive · expired · used · archived.
-- Solo `ok` y `accepted` entregan datos, y solo a la persona invitada (o a la que la aceptó).
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
revoke all on function public.invitation_preview(text) from public, anon, authenticated;
grant execute on function public.invitation_preview(text) to authenticated;
