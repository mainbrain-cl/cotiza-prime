-- Sprint 5 · H-004a · Verificación en dos pasos · decisión D1-B de Aarón: la base de datos TAMBIÉN exige el segundo paso
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261112100000_mfa_session_gate.down.sql
-- Especificación: plan de H-004a (docs/arquitectura/sprint-5-equipo-y-permisos.md §5b y el registro de construcción de H-004a).
--
-- El problema: la aplicación detiene a quien ingresó solo con la contraseña (sesión «parcial», pase aal1) cuando su cuenta
-- tiene la verificación en dos pasos activa. Pero la dirección de Supabase y su llave pública NO son secretas: con la
-- contraseña, alguien puede pedir un pase aal1 directo a `/auth/v1/token` y leer o escribir por `/rest/v1/...` poniendo la
-- cabecera de la organización, saltándose la pantalla del código. Esta migración cierra ese camino en la base.
--
-- Qué cambia:
--   1. `app.second_step_pending()` (nueva): verdadero si la cuenta tiene un factor VERIFICADO en `auth.mfa_factors` y el pase
--      NO es aal2. Primero mira el nivel del pase (barato) y solo si no es aal2 busca el factor, así quien ya pasó el segundo
--      paso, o no tiene factor, casi no paga nada. Una cuenta sin factor, o con un factor sin verificar, se comporta
--      exactamente igual que antes.
--   2. `app.current_tenant_id()`: al inicio, si el segundo paso está pendiente devuelve null. Todo lo que cuelga de ella (las
--      políticas de cada tabla, `current_member_role`, `has_role`, `can`, las funciones públicas) deja de ver y de escribir.
--      El resto del cuerpo es la copia LITERAL de 20261001120200_tenants_profiles_members.sql (la vigente).
--   3. `app.my_tenant_ids()`: agrega `and not app.second_step_pending()`: con la sesión parcial el selector de
--      organizaciones queda vacío. El resto es la copia LITERAL de la misma migración.
--   4. Política `members_select` (de 20261105110000_member_management.sql): su rama «las filas propias» (`user_id = auth.uid()`)
--      sigue leyéndose por la API aunque `my_tenant_ids()` y `current_tenant_id()` devuelvan nada, y mostraría a una sesión
--      parcial en qué organizaciones está y con qué rol. Se le agrega `and not app.second_step_pending()` a esa rama; la otra
--      rama (la organización activa) ya queda cerrada por `current_tenant_id()`. DESVIACIÓN DEL PLAN (que solo nombraba las dos
--      funciones): se encontró al probar «la sesión parcial ve 0 filas» y se cerró por ser el lado seguro.
--   5. Alcances nuevos del límite de intentos (`auth_rate_limits`): `mfa_verify_user` (fallos por cuenta cada 15 min),
--      `mfa_verify_user_day` (fallos por cuenta en el día) y `mfa_code_used` (un mismo código no sirve dos veces). Sus
--      claves son huellas de «alcance|cuenta», nunca el correo, la IP ni el código.
--
-- Lo que NO cambia (a propósito): `app.effective_role()` (el rol bajado a Observador para quien no tiene factor es H-004c) y
-- las políticas de los datos propios de la cuenta (`profiles`, `legal_acceptances`: la persona ve lo suyo, no el de ninguna
-- organización). Las funciones públicas que usan `auth.uid()` sin organización (por ejemplo `create_tenant`,
-- `accept_invitation`) tampoco: la aplicación las detiene en `requireUser`; endurecerlas en la base es una mejora aparte.
--
-- Rendimiento: las políticas llaman a `current_tenant_id()` una vez por consulta (`(select app.current_tenant_id())`) y la
-- función nueva hace como mucho una búsqueda por el índice de `auth.mfa_factors (user_id, created_at)`.
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia `set local lock_timeout = '3s'` y, justo después, la
-- verificación de que el valor quedó puesto.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261112100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

-- 1. ¿Falta el segundo paso? ---------------------------------------------------------------------------------------------
create function app.second_step_pending() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2'
     and exists (select 1 from auth.mfa_factors f
                 where f.user_id = auth.uid() and f.status = 'verified')
$$;
-- `authenticated` debe poder ejecutarla: la nombra una política (`members_select`), que corre con el rol de quien consulta.
-- Solo dice si la propia sesión está a medias; `app` no está expuesta por la API (config.toml: schemas = public).
revoke all on function app.second_step_pending() from public, anon;
grant execute on function app.second_step_pending() to authenticated;

-- 2. Organización activa: con el segundo paso pendiente no hay organización -----------------------------------------------
create or replace function app.current_tenant_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_headers text := nullif(current_setting('request.headers', true), '');
  v_raw     text;
  v_tid     uuid;
begin
  if app.second_step_pending() then
    return null;
  end if;
  if v_headers is null or auth.uid() is null then
    return null;
  end if;
  begin
    v_raw := nullif(v_headers::json ->> 'x-cp-tenant-id', '');
    v_tid := v_raw::uuid;
  exception when others then
    return null;
  end;
  if v_tid is null then
    return null;
  end if;
  if exists (
    select 1
    from public.members m
    join public.tenants t on t.tenant_id = m.tenant_id
    where m.tenant_id = v_tid
      and m.user_id   = auth.uid()
      and m.status    = 'active'
      and t.status    = 'active'
      and t.kind      = 'organization'
  ) then
    return v_tid;
  end if;
  return null;
end $$;

-- 3. Organizaciones de la persona (selector): con el segundo paso pendiente, ninguna ----------------------------------------
create or replace function app.my_tenant_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.tenant_id from public.members m
  where m.user_id = auth.uid() and m.status = 'active'
    and not app.second_step_pending()
$$;

-- 4. Las filas propias de `members` tampoco se leen con el segundo paso pendiente ------------------------------------------
alter policy members_select on public.members
  using (
    (user_id = (select auth.uid()) and not (select app.second_step_pending()))
    or (tenant_id = (select app.current_tenant_id())
        and (status = 'active' or (select app.can('team.manage'))))
  );

-- 5. Alcances nuevos del límite de intentos ------------------------------------------------------------------------------
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant',
                   'share_ip', 'share_token', 'share_respond_ip', 'quote_send_user',
                   'intake_read_ip', 'intake_submit_ip', 'intake_submit_ip_day', 'intake_submit_form',
                   'invite_accept_user', 'invite_link_ip',
                   'mfa_verify_user', 'mfa_verify_user_day', 'mfa_code_used'));
