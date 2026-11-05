-- Sprint 5 · H-009 · Corrección I1 de la revisión adversarial · la vista previa de una invitación es SOLO LECTURA
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
-- Qué cambia: `invitation_preview` ya no cuenta fallos, no escribe auditoría y no toca ninguna tabla. SÍ lee el
-- estado del tope de la cuenta para devolver `rate_limited` si ya estaba bloqueada (leer no daña). Contar fallos y
-- auditar quedan SOLO en `accept_invitation` (el botón «Unirme», una acción de servidor = POST con revisión de
-- origen). Los códigos tienen 256 bits: contar los fallos de la vista previa no protegía nada real.
--
-- Qué NO cambia: la firma, lo que devuelve (cada resultado y sus campos) y los permisos (solo `authenticated`;
-- `anon` y `public` no la ejecutan). Sigue siendo `SECURITY DEFINER` con `search_path = ''`. Sigue rechazando una
-- transacción de solo lectura (25006), como `accept_invitation`: ya no hace falta para la vista previa, pero se
-- mantiene para no cambiar quién puede llamarla. Ya no toma el candado por cuenta (solo servía para contar).
--
-- Consecuencia consciente: la pantalla «Cambia de cuenta para unirte» (correo equivocado) ya NO deja fila en la
-- auditoría al verse; solo la deja un intento real de aceptar (`accept_invitation`, motivo `wrong_email`).

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
