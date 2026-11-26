-- H-116 · Etapa 1 · Que nadie pueda adueñarse de una cuenta registrándose antes con su correo: la base de datos
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261125100000_account_setup.down.sql
-- Diseño: docs/arquitectura/h-116-registro-seguro.md (§3.4 y «Registro de construcción — Etapa 1»). Es la segunda capa: la primera
-- (registro público apagado y pasarela del servidor) vive en la aplicación y llega en las etapas 2 y 3.
--
-- El problema: Supabase deja que cualquiera cree una cuenta con un correo AJENO y su propia contraseña; cuando la dueña del correo
-- verifica, la contraseña del atacante sigue sirviendo. La base debe impedir que una cuenta se use mientras nadie con el correo
-- verificado haya fijado lo suyo (nombre, contraseña, términos) desde la sesión que abrió el enlace del correo.
--
-- Qué hace (una sola migración):
--   1. `profiles.account_ready_at` (vacía = cuenta SIN terminar) y `profiles.signup_email` (el correo de alta, en minúsculas). Las
--      personas no tienen permiso sobre ellas (la lectura y la escritura de `profiles` son POR COLUMNA).
--   2. `app.handle_new_user` anota `signup_email` y ya NO registra el consentimiento desde `raw_user_meta_data.accepted_legal`: ese dato
--      lo escribe quien CREA la cuenta, que puede no ser la persona.
--   3. `app.forbid_email_change` + disparador `before update` en `auth.users`: hasta H-109 el correo de una cuenta no cambia (rechaza
--      42501 cambiar `email` y anotar un cambio pendiente en `email_change`). Interruptor `app.allow_email_change`, solo para SQL
--      directo en la misma conexión (GoTrue usa otra, no lo alcanza).
--   4. `app.account_ready(uuid)`: cuenta terminada Y correo actual = correo de alta. `app.session_alive()`: el `session_id` del pase
--      existe en `auth.sessions` (un pase de una sesión cerrada sirve hasta 15 minutos en PostgREST; aquí no). `app.session_from_email_link()`:
--      `amr` con un método de enlace del correo (`otp`, `magiclink`, `recovery`, `invite`) y ninguno `password`.
--   5. `public.account_setup_preflight`, `public.my_account_ready` y `public.complete_account_setup` (+ las ayudas `app.account_setup_verdict`
--      y `app.setup_denied`). Terminar la cuenta borra las aceptaciones que ya hubiera (las escribió quien creó la cuenta) y deja
--      `legal.acceptance_discarded` en la auditoría por cada una.
--   6. `public.create_tenant`, `public.invitation_preview` y `public.accept_invitation` exigen sesión abierta y cuenta terminada;
--      `app.current_tenant_id()` y `app.my_tenant_ids()` devuelven vacío sin sesión abierta; las políticas `profiles_update`,
--      `profiles_select` y `members_select` (sus ramas «filas propias») la exigen. Las funciones son copias LITERALES de la definición
--      vigente (20261112100000_mfa_session_gate) con solo las líneas nuevas.
--   7. Alcance nuevo `signup_email` del límite de intentos.
--   8. Relleno: todas las cuentas reciben `signup_email`; las ya verificadas y con contraseña pasan a terminadas; se borran los cambios
--      de correo pendientes ANTES de crear el disparador.
--
-- Bloqueos: `alter table public.profiles add column` toma un bloqueo exclusivo breve; crear el disparador toma un bloqueo sobre
-- `auth.users`. Aplicar sobre la base vacía o en una ventana tranquila (docs/arquitectura/modelo-datos.md §9.4).
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia `set local lock_timeout = '3s'` y, justo después, la verificación de
-- que el valor quedó puesto.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261125100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

-- 1. Columnas del perfil ---------------------------------------------------------------------------------------------------
-- Las personas NO reciben permiso sobre ellas: `authenticated` solo tiene `select` y `update` POR COLUMNA sobre `profiles`
-- (20261001150000_profiles_column_privacy, 20261001120200), así que una columna nueva nace sin permisos. Las escriben solo
-- `app.handle_new_user` (`signup_email`) y `public.complete_account_setup` (`account_ready_at`).
alter table public.profiles
  add column account_ready_at timestamptz,
  add column signup_email     text,
  add constraint profiles_signup_email_check
    check (signup_email is null or (signup_email = lower(signup_email) and char_length(signup_email) <= 320));
comment on column public.profiles.account_ready_at is 'H-116: cuando la persona terminó de crear su cuenta (nombre, contraseña y términos fijados después de verificar el correo, desde la sesión de un enlace del correo). Vacía = sin terminar. Sin permiso para las personas.';
comment on column public.profiles.signup_email is 'H-116: el correo (en minúsculas) con el que se creó la cuenta. La cuenta solo se termina, y solo cuenta como terminada, mientras su correo actual sea este. Sin permiso para las personas.';

-- 2. Relleno de las cuentas que ya existen ---------------------------------------------------------------------------------
-- Todas reciben su correo actual. Las ya verificadas y con contraseña pasan a terminadas (hoy son las que usan el producto; no hay
-- producción: solo la base local de pruebas). Las demás (sin verificar o sin contraseña) quedan sin terminar.
update public.profiles p
   set signup_email = lower(btrim(u.email))
  from auth.users u
 where u.id = p.user_id and coalesce(btrim(u.email), '') <> '';
update public.profiles p
   set account_ready_at = now()
  from auth.users u
 where u.id = p.user_id and p.signup_email is not null and u.email_confirmed_at is not null
   and coalesce(u.encrypted_password, '') <> '' and u.deleted_at is null;

-- 3. El correo de una cuenta no cambia hasta H-109 -----------------------------------------------------------------------
-- Primero se borran los cambios de correo que ya estuvieran a medias (el disparador no los dejaría terminar): ninguna cuenta queda
-- con un cambio pendiente.
update auth.users
   set email_change = '', email_change_token_new = '', email_change_token_current = '', email_change_confirm_status = 0
 where coalesce(email_change, '') <> '' or coalesce(email_change_token_new, '') <> ''
    or coalesce(email_change_token_current, '') <> '' or email_change_confirm_status <> 0;
delete from auth.one_time_tokens where token_type in ('email_change_token_new', 'email_change_token_current');

create function app.forbid_email_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Interruptor de soporte: solo vale en la conexión SQL que lo fija (`set local app.allow_email_change = 'on'` dentro de una
  -- transacción). GoTrue usa otra conexión, así que NO lo alcanza. Las personas no pueden fijarlo por la API.
  if current_setting('app.allow_email_change', true) is not distinct from 'on' then
    return new;
  end if;
  if old.email is distinct from new.email then
    raise exception 'email_change_forbidden' using errcode = '42501';
  end if;
  -- Un cambio de correo pendiente (lo que anota `PUT /auth/v1/user { email }`): `email_change` pasa de vacío (NULL o '') a tener valor.
  if coalesce(old.email_change, '') = '' and coalesce(new.email_change, '') <> '' then
    raise exception 'email_change_forbidden' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function app.forbid_email_change() from public, anon, authenticated;

create trigger forbid_email_change before update on auth.users
  for each row execute function app.forbid_email_change();

-- 4. Ayudas internas de la sesión y de la cuenta ------------------------------------------------------------

-- ¿Sigue abierta la sesión del pase? PostgREST solo revisa la firma y el vencimiento del pase (hasta 15 minutos): un pase cuya
-- sesión se cerró (`signOut`, cierre de las otras sesiones, factor anulado) seguiría sirviendo. Aquí se comprueba contra
-- `auth.sessions`: el `session_id` del pase existe, es de `auth.uid()` y no venció (`not_after`). El `session_id` se conserva al
-- renovar el pase (comprobado en la etapa 0). Un `session_id` que no es un uuid vale «cerrada» (el `case` evita que el cast falle).
create function app.session_alive() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select true
    from auth.sessions s
    where s.id = case
            when (auth.jwt() ->> 'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (auth.jwt() ->> 'session_id')::uuid
          end
      and s.user_id = auth.uid()
      and (s.not_after is null or s.not_after > now())
  ), false)
$$;
-- Las políticas la nombran (`profiles_update`) y corren con el rol de quien consulta: `authenticated` debe poder ejecutarla.
-- Solo dice si la propia sesión sigue abierta; `app` no está expuesta por la API (config.toml: schemas = public).
revoke all on function app.session_alive() from public, anon;
grant execute on function app.session_alive() to authenticated;

-- ¿La sesión del pase nació de un enlace del correo (y no de la contraseña)? Lee `amr` (la marca de cómo se abrió la sesión), que
-- puede venir como lista de objetos `{method, timestamp}` (GoTrue) o como lista de textos. Verdadera si hay un método de enlace del
-- correo y NINGUNO es `password`. Etapa 0: el enlace del correo trae `[{method: "otp"}]` y la contraseña `password`.
create function app.session_from_email_link() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_amr     jsonb := auth.jwt() -> 'amr';
  v_methods text[];
begin
  if v_amr is null or jsonb_typeof(v_amr) <> 'array' then
    return false;
  end if;
  select coalesce(array_agg(case jsonb_typeof(e.value)
                              when 'string' then e.value #>> '{}'
                              when 'object' then e.value ->> 'method'
                            end), '{}')
    into v_methods
    from jsonb_array_elements(v_amr) e;
  return exists (select 1 from unnest(v_methods) m where m in ('otp', 'magiclink', 'recovery', 'invite'))
         and not ('password' = any (v_methods));
end $$;
revoke all on function app.session_from_email_link() from public, anon, authenticated;

-- ¿La cuenta está terminada de verdad? `account_ready_at` puesta Y el correo actual (en minúsculas) es el de alta
-- (`signup_email`): una cuenta cuyo correo cambió deja de contar como terminada aunque el disparador faltara. Solo la llaman otras
-- funciones de la base (`security definer`): nadie con un pase la ejecuta.
create function app.account_ready(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.profiles p
    join auth.users u on u.id = p.user_id
    where p.user_id = p_user
      and p.account_ready_at is not null
      and p.signup_email is not null
      and lower(u.email) = p.signup_email
      and u.deleted_at is null
  )
$$;
revoke all on function app.account_ready(uuid) from public, anon, authenticated;

-- Rechazo auditado de «terminar la cuenta». Una fila por cuenta, motivo y hora: quien insiste (o un pase robado) no llena el
-- registro. Va en la organización «plataforma» (la cuenta todavía puede no tener ninguna). No guarda el correo.
create function app.setup_denied(p_user uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.audit_log a
              where a.tenant_id = app.platform_tenant_id() and a.actor_user_id = p_user
                and a.action = 'account.setup_denied' and a.details ->> 'reason' = p_reason
                and a.occurred_at > now() - interval '1 hour') then
    return;
  end if;
  perform app.write_audit(app.platform_tenant_id(), 'user', p_user, 'account.setup_denied', 'profile', p_user, 'denied',
                          jsonb_build_object('reason', p_reason));
end $$;
revoke all on function app.setup_denied(uuid, text) from public, anon, authenticated;

-- Los chequeos de «terminar la cuenta», en un solo lugar: los usan `complete_account_setup` y `account_setup_preflight` para no
-- divergir. Devuelve el PRIMER motivo de rechazo o `ok` (puede terminarse) o `already_ready` (ya estaba terminada). No escribe nada.
-- Recibe la cuenta y su sesión (no lee el pase: la puerta del segundo paso y la sesión abierta las comprueban las funciones públicas
-- antes de llamarla). Orden: sesión de enlace del correo, correo verificado, correo de alta, ya terminada, verificación en dos pasos presente, nombre,
-- versiones legales y (solo si se pide) otras sesiones abiertas.
create function app.account_setup_verdict(
  p_user uuid, p_session uuid,
  p_full_name text, p_terms_version text, p_privacy_version text, p_check_other_sessions boolean
) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_email     text;
  v_confirmed timestamptz;
  v_signup    text;
  v_ready     timestamptz;
  v_name      text := btrim(p_full_name);
begin
  -- 1. la sesión nació de un enlace del correo (no de la contraseña)
  if not app.session_from_email_link() then
    return 'not_email_link';
  end if;
  -- 2. correo verificado, 3. correo actual = correo de alta
  select lower(u.email::text), u.email_confirmed_at, p.signup_email, p.account_ready_at
    into v_email, v_confirmed, v_signup, v_ready
    from auth.users u join public.profiles p on p.user_id = u.id
   where u.id = p_user and u.deleted_at is null;
  if not found or v_confirmed is null then
    return 'unverified';
  end if;
  if v_signup is null or v_email is distinct from v_signup then
    return 'email_changed';
  end if;
  -- ya terminada: repetirla no cambia nada
  if v_ready is not null then
    return 'already_ready';
  end if;
  -- 4. ninguna verificación en dos pasos inscrita (con la configuración bien puesta es imposible; si ocurre, soporte la resuelve)
  if exists (select 1 from auth.mfa_factors f where f.user_id = p_user) then
    return 'factor_present';
  end if;
  -- 5. nombre de 1 a 120 caracteres, sin caracteres de control
  if v_name is null or char_length(v_name) not between 1 and 120 or v_name ~ '[\x01-\x1f\x7f]' then
    return 'invalid_name';
  end if;
  -- 6. las versiones de términos y privacidad son las vigentes
  if exists (select 1 from public.legal_documents d
              where d.is_current
                and ((d.kind = 'terms' and d.version is distinct from p_terms_version)
                     or (d.kind = 'privacy' and d.version is distinct from p_privacy_version))) then
    return 'legal_changed';
  end if;
  -- 7. no queda otra sesión abierta de la cuenta (la acción ya hizo `signOut({ scope: "others" })`)
  if p_check_other_sessions then
    if exists (select 1 from auth.sessions s where s.user_id = p_user and s.id is distinct from p_session) then
      return 'other_sessions';
    end if;
  end if;
  return 'ok';
end $$;
revoke all on function app.account_setup_verdict(uuid, uuid, text, text, text, boolean) from public, anon, authenticated;

-- 4b. Terminar la cuenta --------------------------------------------------------------------------------

-- Validar SIN escribir: los mismos chequeos de `complete_account_setup` (menos «otras sesiones»), para que `/crear-cuenta` sepa si
-- la base va a rechazar ANTES de fijar la contraseña. No audita nada: no cambia nada, así que no hay intento que registrar.
create function public.account_setup_preflight(
  p_full_name text, p_terms_version text, p_privacy_version text
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_verdict text;
begin
  if app.second_step_pending() then
    raise exception 'second_step_required' using errcode = '42501';
  end if;
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not app.session_alive() then
    raise exception 'session_closed' using errcode = '42501';
  end if;
  v_verdict := app.account_setup_verdict(v_uid, (auth.jwt() ->> 'session_id')::uuid,
                                         p_full_name, p_terms_version, p_privacy_version, false);
  return jsonb_build_object('result', case v_verdict when 'already_ready' then 'ok' else v_verdict end);
end $$;
revoke all on function public.account_setup_preflight(text, text, text) from public, anon;
grant execute on function public.account_setup_preflight(text, text, text) to authenticated;

-- ¿La cuenta propia está terminada? La usa `requireUser`. Solo mira la cuenta de quien llama.
create function public.my_account_ready() returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if app.second_step_pending() then
    raise exception 'second_step_required' using errcode = '42501';
  end if;
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not app.session_alive() then
    raise exception 'session_closed' using errcode = '42501';
  end if;
  return app.account_ready(auth.uid());
end $$;
revoke all on function public.my_account_ready() from public, anon;
grant execute on function public.my_account_ready() to authenticated;

-- Terminar la cuenta: solo desde una sesión que nació del enlace del correo, con el correo de alta y sin otras sesiones abiertas.
-- Responde `{result: 'completed', already_ready}` o el motivo del rechazo (`not_email_link`, `unverified`, `email_changed`,
-- `factor_present`, `invalid_name`, `legal_changed`, `other_sessions`). Los rechazos que importan a la seguridad (`not_email_link`,
-- `email_changed`, `factor_present`) se AUDITAN como `account.setup_denied`: por eso se RESPONDEN y no se lanzan (un error revertiría
-- la fila de auditoría). Sin sesión, con una sesión cerrada o en solo lectura sí se lanza un error.
create function public.complete_account_setup(
  p_full_name text, p_terms_version text, p_privacy_version text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid       uuid := auth.uid();
  v_headers   json := nullif(current_setting('request.headers', true), '')::json;
  v_ip        inet;
  v_agent     text;
  v_verdict   text;
  v_discarded integer := 0;
  v_old       record;
begin
  if app.second_step_pending() then
    raise exception 'second_step_required' using errcode = '42501';
  end if;
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not app.session_alive() then
    raise exception 'session_closed' using errcode = '42501';
  end if;
  -- Escribe: un GET de PostgREST corre en solo lectura y no se atiende.
  if current_setting('transaction_read_only') = 'on' then
    raise exception 'read_only' using errcode = '25006';
  end if;
  -- Un candado por cuenta, hasta el fin de la transacción: dos «Crear mi cuenta» a la vez pasan en fila.
  perform pg_advisory_xact_lock(hashtextextended('account_setup|' || v_uid::text, 0));

  v_verdict := app.account_setup_verdict(v_uid, (auth.jwt() ->> 'session_id')::uuid,
                                         p_full_name, p_terms_version, p_privacy_version, true);
  if v_verdict in ('not_email_link', 'email_changed', 'factor_present') then
    perform app.setup_denied(v_uid, v_verdict);
  end if;
  if v_verdict = 'already_ready' then
    return jsonb_build_object('result', 'completed', 'already_ready', true);
  end if;
  if v_verdict <> 'ok' then
    return jsonb_build_object('result', v_verdict);
  end if;

  -- Todo lo escrito antes de terminar (aceptaciones de términos y privacidad) lo escribió quien CREÓ la cuenta, no necesariamente
  -- la persona: se descarta, y la auditoría conserva el rastro. Se borra y no se sobrescribe porque `legal_acceptances` no admite
  -- cambios (`legal_acceptances_no_update`); no hay disparador de borrado.
  for v_old in
    with gone as (delete from public.legal_acceptances a where a.user_id = v_uid returning a.document_id, a.accepted_at, a.context)
    select g.document_id, g.accepted_at, g.context, d.kind, d.version
      from gone g left join public.legal_documents d on d.id = g.document_id
  loop
    v_discarded := v_discarded + 1;
    perform app.write_audit(app.platform_tenant_id(), 'user', v_uid, 'legal.acceptance_discarded', 'legal_document',
                            v_old.document_id, 'success',
                            jsonb_build_object('kind', v_old.kind, 'version', v_old.version,
                                               'accepted_at', v_old.accepted_at, 'context', v_old.context));
  end loop;

  begin v_ip := nullif(v_headers ->> 'x-cp-client-ip', '')::inet;
  exception when others then v_ip := null; end;
  v_agent := left(nullif(v_headers ->> 'user-agent', ''), 300);
  insert into public.legal_acceptances (user_id, document_id, context, origin_ip, user_agent)
  select v_uid, d.id, 'signup', v_ip, v_agent from public.legal_documents d where d.is_current;

  update public.profiles
     set full_name = btrim(p_full_name), account_ready_at = now()
   where user_id = v_uid;

  perform app.write_audit(app.platform_tenant_id(), 'user', v_uid, 'account.setup_completed', 'profile', v_uid, 'success',
                          jsonb_build_object('discarded_acceptances', v_discarded));
  return jsonb_build_object('result', 'completed', 'already_ready', false);
end $$;
revoke all on function public.complete_account_setup(text, text, text) from public, anon;
grant execute on function public.complete_account_setup(text, text, text) to authenticated;


-- 5. La alta de la cuenta ------------------------------------------------------------------------------------------------------
-- Copia de la definición de 20261001120400_legal.sql con dos cambios: anota `signup_email` y se quita la rama que registraba la
-- aceptación de términos desde los metadatos de quien crea la cuenta.
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  v_name := left(coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Usuario'
  ), 120);

  -- H-116: se anota el correo con que se creó la cuenta (`signup_email`); la cuenta queda SIN terminar (`account_ready_at` vacía)
  -- hasta `complete_account_setup`. Ya no se registra el consentimiento desde `raw_user_meta_data.accepted_legal`: ese dato lo
  -- escribe quien CREA la cuenta, que puede no ser la persona (el consentimiento lo escribe `complete_account_setup`).
  insert into public.profiles (user_id, full_name, signup_email)
  values (new.id, v_name, nullif(lower(btrim(coalesce(new.email, ''))), ''));
  return new;
end $$;

-- 6. La organización activa, el selector y el perfil exigen sesión abierta -----------------------------------------------------
-- Copias LITERALES de la definición vigente (20261112100000_mfa_session_gate) con SOLO las líneas de `app.session_alive()`.
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
  -- H-116: un pase cuya sesión ya se cerró no sirve, aunque no haya vencido (PostgREST solo revisa firma y vencimiento).
  if not app.session_alive() then
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

create or replace function app.my_tenant_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.tenant_id from public.members m
  where m.user_id = auth.uid() and m.status = 'active'
    and not app.second_step_pending()
    and app.session_alive()
$$;

alter policy profiles_update on public.profiles
  using (user_id = (select auth.uid()) and not (select app.second_step_pending()) and (select app.session_alive()))
  with check (user_id = (select auth.uid()) and not (select app.second_step_pending()) and (select app.session_alive()));
-- Las ramas «filas propias» de `members_select` y `profiles_select` tampoco se leen con una sesión cerrada (el diseño original las dejaba
-- legibles: su propia membresía y su propio perfil; se cierran por ser el lado seguro, ver el registro de construcción de la etapa 1).
alter policy members_select on public.members
  using (
    (user_id = (select auth.uid()) and not (select app.second_step_pending()) and (select app.session_alive()))
    or (tenant_id = (select app.current_tenant_id())
        and (status = 'active' or (select app.can('team.manage'))))
  );
alter policy profiles_select on public.profiles
  using (
    (user_id = (select auth.uid()) and not (select app.second_step_pending()) and (select app.session_alive()))
    or user_id in (select app.current_tenant_people())
  );

-- 7. Las tres funciones públicas exigen sesión abierta y cuenta terminada ------------------------------------------------------
-- Copias LITERALES de la definición vigente (20261112100000_mfa_session_gate) con SOLO las líneas de H-116. Los permisos se
-- conservan al reemplazarlas.

create or replace function public.create_tenant(
  p_name          text,
  p_rut           text,
  p_industry      text default null,
  p_contact_email text default null,
  p_contact_phone text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid       uuid := auth.uid();
  v_confirmed boolean;
  v_rut       text;
  v_owned     integer;
  v_tenant    uuid;
begin
  if app.second_step_pending() then
    raise exception 'second_step_required' using errcode = '42501';
  end if;
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  -- H-116: la sesión del pase sigue abierta.
  if not app.session_alive() then
    raise exception 'session_closed' using errcode = '42501';
  end if;

  -- H-001: el correo debe estar verificado, comprobado aquí y no solo en la pantalla.
  select (u.email_confirmed_at is not null) into v_confirmed from auth.users u where u.id = v_uid;
  if not coalesce(v_confirmed, false) then
    raise exception 'Verifica tu correo antes de crear una organización' using errcode = '42501';
  end if;
  -- H-116: la cuenta está terminada (nombre, contraseña y términos fijados DESPUÉS de verificar el correo) y su correo sigue
  -- siendo el de alta. Una cuenta sin terminar puede tener una contraseña que eligió otra persona.
  if not app.account_ready(v_uid) then
    raise exception 'Termina de crear tu cuenta antes de crear una organización' using errcode = '42501';
  end if;

  -- Formato del correo de contacto: se comprueba aquí y no solo en la pantalla.
  if p_contact_email is not null and p_contact_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'El correo de contacto no es válido' using errcode = '22023';
  end if;

  v_rut := app.normalize_rut(p_rut);
  if not app.is_valid_rut(v_rut) then
    raise exception 'El RUT no es válido' using errcode = '22023';
  end if;

  -- Tope por persona, contra el abuso del registro abierto. El candado evita que dos
  -- peticiones simultáneas pasen el tope a la vez.
  perform pg_advisory_xact_lock(hashtextextended('create_tenant:' || v_uid::text, 0));
  select count(*) into v_owned
  from public.members m
  join public.tenants t on t.tenant_id = m.tenant_id and t.kind = 'organization'
  where m.user_id = v_uid and m.role = 'owner' and m.status = 'active';
  if v_owned >= app.max_tenants_per_user() then
    raise exception 'Alcanzaste el máximo de % organizaciones', app.max_tenants_per_user()
      using errcode = '53400';
  end if;

  insert into public.tenants (name, rut, industry, contact_email, contact_phone, created_by)
  values (btrim(p_name), v_rut, p_industry, p_contact_email, p_contact_phone, v_uid)
  returning tenant_id into v_tenant;

  insert into public.members (tenant_id, user_id, role) values (v_tenant, v_uid, 'owner');
  insert into public.numbering_settings (tenant_id, updated_by) values (v_tenant, v_uid);
  update public.profiles set last_tenant_id = v_tenant where user_id = v_uid;

  return v_tenant;
end $$;

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
  if app.second_step_pending() then
    raise exception 'second_step_required' using errcode = '42501';
  end if;
  -- 1. sesión, y que la transacción no sea de solo lectura
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- H-116: la sesión del pase sigue abierta.
  if not app.session_alive() then
    raise exception 'session_closed' using errcode = '42501';
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
  -- H-116: una cuenta sin terminar (o con el correo cambiado) no acepta invitaciones: es el mismo resultado `unverified`.
  if not app.account_ready(v_uid) then
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
  if app.second_step_pending() then
    raise exception 'second_step_required' using errcode = '42501';
  end if;
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- H-116: la sesión del pase sigue abierta.
  if not app.session_alive() then
    raise exception 'session_closed' using errcode = '42501';
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
  -- H-116: una cuenta sin terminar (o con el correo cambiado) no acepta invitaciones: es el mismo resultado `unverified`.
  if not app.account_ready(v_uid) then
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

-- 8. Alcance nuevo del límite de intentos --------------------------------------------------------------------------------------
-- `signup_email` (copia de la lista de 20261113100000 + el nuevo): el tope por correo del registro (1 por minuto y 3 por hora).
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant',
                   'share_ip', 'share_token', 'share_respond_ip', 'quote_send_user',
                   'intake_read_ip', 'intake_submit_ip', 'intake_submit_ip_day', 'intake_submit_form',
                   'invite_accept_user', 'invite_link_ip',
                   'mfa_verify_user', 'mfa_verify_user_day', 'mfa_code_used',
                   'mfa_annul_ip', 'mfa_annul_token',
                   'signup_email'));
