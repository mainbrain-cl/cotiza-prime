-- Sprint 5 · H-118b · Anular la activación del segundo paso desde el enlace del correo de aviso
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261113110000_mfa_annul.down.sql
-- Especificación: docs/arquitectura/h-118-anular-activacion.md (§3 y §4) y su registro de construcción (etapa B).
--
-- Cuatro funciones SOLO del servidor (llave maestra), sobre las tablas de la etapa A (20261113100000):
--   1. `mfa_annul_claim(huella)`: TOMA el enlace por 2 minutos (`for update`). Devuelve el MISMO `{result: 'invalid'}` si la
--      huella no tiene la forma, no existe, venció, ya se usó, está tomado por otra llamada o su aviso no está `sent` ni `pending`
--      (nunca dice cuál de esas cosas fue). Con éxito devuelve `{result: 'ok', link_id, user_id}` (la cuenta, que el servidor necesita para dejarla sin acceso; el correo
--      NO: lo entrega `mfa_annul_complete`). Solo la llama el servidor con la llave maestra.
--   2. `mfa_annul_complete(link_id)`: consume ESE enlace y TODOS los abiertos de la cuenta (nada hecho desde una sesión los
--      invalida; solo esto), cierra los avisos (`sent`/`pending` → `annulled`; un permiso vivo → `closed`) y audita
--      `session.mfa_annulled` en la plataforma y en cada organización donde la persona está ACTIVA (`actor_type 'public'`,
--      `details {via: 'email_link'}`). Devuelve el correo de la cuenta, leído de `auth.users`, para el correo de recuperación.
--   3. `mfa_annul_release(link_id)`: suelta el enlace tomado si algo falló, para poder abrirlo de nuevo.
--   4. `mfa_revoke_sessions(user)`: borra de `auth.sessions` lo que quede de la cuenta (arrastra los `refresh_tokens`) y
--      devuelve cuántas sesiones y tokens quedan (0 si todo salió bien). Cinturón y tirantes: comprobado en pruebas, cambiar la
--      contraseña con la API de administración YA cierra todas las sesiones; esto lo deja comprobado en la base.
-- Misma plantilla de seguridad que la etapa A: `security definer`, `search_path` vacío, nombres completos, solo `service_role`.
-- Guardia 15: primera sentencia `set local lock_timeout = '3s'` y su verificación. No crea tablas ni toca las existentes.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261113110000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

-- 1. Tomar el enlace ---------------------------------------------------------------------------------------------------------
create function public.mfa_annul_claim(p_token_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_link  public.mfa_annul_links;
  v_state text;
begin
  -- Retención: ver `mfa_alert_expect` (enlaces: 30 días después de vencer; avisos: sin enlaces y de más de 30 días).
  delete from public.mfa_annul_links where expires_at < now() - interval '30 days';
  delete from public.mfa_enrollment_alerts a
   where a.created_at < now() - interval '30 days'
     and not exists (select 1 from public.mfa_annul_links l where l.tenant_id = a.tenant_id and l.alert_id = a.id);
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('result', 'invalid');
  end if;
  -- Bloquea la fila: dos llamadas a la vez se ordenan aquí, y la segunda ve el enlace ya tomado.
  select * into v_link from public.mfa_annul_links l where l.token_sha256 = p_token_sha256 for update;
  if not found
     or v_link.used_at is not null
     or v_link.expires_at <= now()
     or (v_link.claimed_until is not null and v_link.claimed_until > now()) then
    return jsonb_build_object('result', 'invalid');
  end if;
  select a.state into v_state from public.mfa_enrollment_alerts a
   where a.tenant_id = v_link.tenant_id and a.id = v_link.alert_id;
  -- El enlace solo existe si se reservó y se intentó mandar al correo de la cuenta; los avisos revertidos se borran con sus
  -- enlaces. Sirve con el aviso `sent` o `pending` (el correo salió pero no se alcanzó a anotar).
  if v_state is null or v_state not in ('sent', 'pending') then
    return jsonb_build_object('result', 'invalid');
  end if;
  update public.mfa_annul_links set claimed_until = now() + interval '2 minutes' where id = v_link.id;
  return jsonb_build_object('result', 'ok', 'link_id', v_link.id, 'user_id', v_link.user_id);
end $$;

-- 2. Completar: consume los enlaces, cierra los avisos y audita ----------------------------------------------------------------
create function public.mfa_annul_complete(p_link_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_link    public.mfa_annul_links;
  v_email   text;
  v_tenant  uuid;
begin
  if p_link_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into v_link from public.mfa_annul_links l where l.id = p_link_id for update;
  if not found or v_link.used_at is not null then
    return jsonb_build_object('result', 'invalid');
  end if;
  -- Todos los enlaces abiertos de la cuenta se consumen: ninguno sirve ya.
  update public.mfa_annul_links set used_at = now(), claimed_until = null
   where user_id = v_link.user_id and used_at is null;
  update public.mfa_enrollment_alerts set state = 'annulled'
   where user_id = v_link.user_id and state in ('sent', 'pending');
  update public.mfa_enrollment_alerts set state = 'closed', expected_until = now()
   where user_id = v_link.user_id and state = 'expected';
  select u.email::text into v_email from auth.users u where u.id = v_link.user_id and u.deleted_at is null;
  -- Plataforma, y cada organización donde la persona está activa hoy (no las que dejó).
  perform app.write_audit(app.platform_tenant_id(), 'public', v_link.user_id, 'session.mfa_annulled', 'session', null,
                          'success', jsonb_build_object('via', 'email_link'));
  for v_tenant in
    select m.tenant_id from public.members m join public.tenants t on t.tenant_id = m.tenant_id
     where m.user_id = v_link.user_id and m.status = 'active' and t.status = 'active' and t.kind = 'organization'
  loop
    perform app.write_audit(v_tenant, 'public', v_link.user_id, 'session.mfa_annulled', 'session', null,
                            'success', jsonb_build_object('via', 'email_link'));
  end loop;
  return jsonb_build_object('result', 'ok', 'user_id', v_link.user_id, 'email', v_email);
end $$;

-- 3. Soltar el enlace tomado ----------------------------------------------------------------------------------------------------
create function public.mfa_annul_release(p_link_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_link_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  update public.mfa_annul_links set claimed_until = null where id = p_link_id and used_at is null;
  return found;
end $$;

-- 4. Cerrar lo que quede de sesiones de la cuenta ----------------------------------------------------------------------------------
create function public.mfa_revoke_sessions(p_user_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_left integer;
begin
  if p_user_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  delete from auth.sessions where user_id = p_user_id;
  select (select count(*) from auth.sessions s where s.user_id = p_user_id)
       + (select count(*) from auth.refresh_tokens r where r.user_id = p_user_id::text)
    into v_left;
  return v_left;
end $$;

-- 5. Permisos: solo el servidor (llave maestra) --------------------------------------------------------------------------------------
revoke all on function public.mfa_annul_claim(text) from public, anon, authenticated;
revoke all on function public.mfa_annul_complete(uuid) from public, anon, authenticated;
revoke all on function public.mfa_annul_release(uuid) from public, anon, authenticated;
revoke all on function public.mfa_revoke_sessions(uuid) from public, anon, authenticated;
grant execute on function public.mfa_annul_claim(text) to service_role;
grant execute on function public.mfa_annul_complete(uuid) to service_role;
grant execute on function public.mfa_annul_release(uuid) to service_role;
grant execute on function public.mfa_revoke_sessions(uuid) to service_role;
