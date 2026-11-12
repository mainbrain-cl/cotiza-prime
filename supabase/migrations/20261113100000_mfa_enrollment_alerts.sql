-- Sprint 5 · H-118a · Aviso de activación del segundo paso, con un «permiso» que cierra la activación directa por la API
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261113100000_mfa_enrollment_alerts.down.sql
-- Especificación: docs/arquitectura/h-118-anular-activacion.md (§2 y §3) y su registro de construcción (etapa A).
--
-- El problema: quien conoce la contraseña de una cuenta SIN el segundo paso puede entrar, activar su propio teléfono y dejar
-- fuera a la dueña (Supabase cierra las otras sesiones al verificar el primer factor). El remedio (H-118b) es un enlace de
-- un solo uso, en un correo de aviso, que anula esa activación. Pero la dirección de Supabase y su llave pública NO son
-- secretas: la activación también se puede pedir hablando DIRECTO con Supabase, sin pasar por nuestro servidor, y entonces
-- nunca saldría el aviso. Esta migración lo cierra en la base:
--   1. `public.mfa_enrollment_alerts`: un aviso por activación. Nace como `expected` («permiso» que deja NUESTRO servidor
--      justo antes de verificar el factor; vive 2 minutos), pasa a `pending` cuando el factor se verifica (lo escribe el
--      disparador, en la misma transacción) y a `sent` cuando el proveedor de correo aceptó el aviso. Si el correo no
--      sale, el servidor revierte la activación (`reverted`).
--   2. `public.mfa_annul_links`: un enlace de anulación por correo enviado (solo su huella sha256, vigencia 72 horas).
--      Aquí solo se CREAN; usarlos (reclamar, completar, soltar) es de la etapa B.
--   3. `app.mfa_factor_verify_gate()` + un disparador `before update` sobre `auth.mfa_factors`: cuando un factor pasa a
--      «verificado» exige el permiso vigente de ESA cuenta y de ESE factor, y que sea TOTP. Sin permiso rechaza con 42501
--      (Supabase no activa nada); con permiso deja el aviso en `pending`. SOLO rechaza: no reescribe nada de Supabase. No
--      actúa sobre factores que ya estaban verificados (Supabase actualiza la fila en cada desafío): los ingresos con
--      factor siguen igual. Tampoco hay disparador de inserción: una activación por la API siempre nace sin verificar.
--   4. Cuatro funciones SOLO del servidor (llave maestra): `mfa_alert_expect`, `mfa_alerts_reserve`, `mfa_alert_settle`,
--      `mfa_alert_revert`.
--   5. Dos alcances nuevos del límite de intentos, para el enlace de anulación (etapa B): `mfa_annul_ip` y `mfa_annul_token`.
--
-- Retención: las filas se borran a los 33 días de creadas (30 días después de que el enlace de 72 horas venció), con la
-- limpieza dentro de `mfa_alert_expect`; no hace falta tarea programada. El rastro queda en `audit_log` (24 meses).
-- Las dos tablas NO guardan el correo: se lee de `auth.users` al enviar. `error_code` guarda solo códigos.
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia `set local lock_timeout = '3s'` y, justo después, la
-- verificación de que el valor quedó puesto. El disparador toma un bloqueo corto sobre `auth.mfa_factors`.
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261113100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

-- 1. Alcances nuevos del límite de intentos (copia de la lista de 20261112100000 + los dos nuevos) -------------------------
alter table public.auth_rate_limits drop constraint auth_rate_limits_scope_check;
alter table public.auth_rate_limits add constraint auth_rate_limits_scope_check
  check (scope in ('login_email', 'login_ip', 'signup_ip', 'tenant_denied_user', 'pdf_user', 'pdf_tenant',
                   'share_ip', 'share_token', 'share_respond_ip', 'quote_send_user',
                   'intake_read_ip', 'intake_submit_ip', 'intake_submit_ip_day', 'intake_submit_form',
                   'invite_accept_user', 'invite_link_ip',
                   'mfa_verify_user', 'mfa_verify_user_day', 'mfa_code_used',
                   'mfa_annul_ip', 'mfa_annul_token'));

-- 2. Un aviso por activación ----------------------------------------------------------------------------------------------
create table public.mfa_enrollment_alerts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null default app.platform_tenant_id()
                      references public.tenants (tenant_id) on update cascade
                      check (tenant_id = app.platform_tenant_id()),
  user_id             uuid not null references auth.users (id) on delete cascade,
  -- Sin llave foránea: el factor se borra al anular o revertir, y la fila queda como rastro.
  factor_id           uuid not null,
  state               text not null default 'expected'
                      check (state in ('expected', 'pending', 'sent', 'reverted', 'annulled', 'closed')),
  expected_until      timestamptz not null,
  verified_at         timestamptz,
  sent_at             timestamptz,
  attempts            integer not null default 0 check (attempts >= 0),
  last_attempt_at     timestamptz,
  provider            text check (provider is null or provider ~ '^[a-z0-9_-]{1,30}$'),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 200),
  error_code          text check (error_code is null or error_code ~ '^[a-z0-9_:.-]{1,60}$'),
  created_at          timestamptz not null default now(),
  unique (tenant_id, id)
);
-- Un solo permiso vivo por cuenta y factor: pedirlo otra vez solo renueva su plazo.
create unique index mfa_enrollment_alerts_expected_one on public.mfa_enrollment_alerts (user_id, factor_id)
  where state = 'expected';
create index mfa_enrollment_alerts_user_state on public.mfa_enrollment_alerts (user_id, state);
create index mfa_enrollment_alerts_created on public.mfa_enrollment_alerts (created_at);

create trigger mfa_enrollment_alerts_forbid_tenant_change
  before update on public.mfa_enrollment_alerts
  for each row execute function app.forbid_tenant_change();

alter table public.mfa_enrollment_alerts enable row level security;
create policy mfa_enrollment_alerts_server_only on public.mfa_enrollment_alerts
  for all to service_role using (true) with check (true);
revoke all on public.mfa_enrollment_alerts from anon, authenticated;
grant select, insert, update, delete on public.mfa_enrollment_alerts to service_role;

-- 3. Un enlace de anulación por correo enviado ------------------------------------------------------------------------------
create table public.mfa_annul_links (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default app.platform_tenant_id()
                references public.tenants (tenant_id) on update cascade
                check (tenant_id = app.platform_tenant_id()),
  alert_id      uuid not null,
  user_id       uuid not null references auth.users (id) on delete cascade,
  -- Solo la huella sha256 del código (64 hexadecimales): el código viaja únicamente en el correo.
  token_sha256  text not null check (token_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at    timestamptz not null,
  claimed_until timestamptz,
  used_at       timestamptz,
  created_at    timestamptz not null default now(),
  foreign key (tenant_id, alert_id) references public.mfa_enrollment_alerts (tenant_id, id) on delete cascade
);
create unique index mfa_annul_links_token on public.mfa_annul_links (token_sha256);
create index mfa_annul_links_open on public.mfa_annul_links (user_id) where used_at is null;
create index mfa_annul_links_expires on public.mfa_annul_links (expires_at);
create index mfa_annul_links_alert on public.mfa_annul_links (tenant_id, alert_id);

create trigger mfa_annul_links_forbid_tenant_change
  before update on public.mfa_annul_links
  for each row execute function app.forbid_tenant_change();

alter table public.mfa_annul_links enable row level security;
create policy mfa_annul_links_server_only on public.mfa_annul_links
  for all to service_role using (true) with check (true);
revoke all on public.mfa_annul_links from anon, authenticated;
grant select, insert, update, delete on public.mfa_annul_links to service_role;

-- 4. El permiso: lo deja NUESTRO servidor justo antes de verificar el factor ------------------------------------------------
-- Devuelve false (sin crear nada) si el factor no es un TOTP SIN verificar de esa cuenta. Vive 2 minutos. También limpia lo
-- viejo (retención, ver arriba).
create function public.mfa_alert_expect(p_user_id uuid, p_factor_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.mfa_enrollment_alerts where created_at < now() - interval '33 days';
  delete from public.mfa_annul_links where expires_at < now() - interval '30 days';
  if p_user_id is null or p_factor_id is null then
    return false;
  end if;
  if not exists (select 1 from auth.mfa_factors f
                  where f.id = p_factor_id and f.user_id = p_user_id
                    and f.factor_type = 'totp' and f.status = 'unverified') then
    return false;
  end if;
  insert into public.mfa_enrollment_alerts (user_id, factor_id, state, expected_until)
  values (p_user_id, p_factor_id, 'expected', now() + interval '2 minutes')
  on conflict (user_id, factor_id) where state = 'expected'
  do update set expected_until = excluded.expected_until;
  return true;
end $$;

-- 5. El disparador: solo rechaza; con permiso vigente deja el aviso en `pending` -------------------------------------------
create function app.mfa_factor_verify_gate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_alert uuid;
begin
  if new.factor_type = 'totp' then
    select a.id into v_alert
      from public.mfa_enrollment_alerts a
     where a.user_id = new.user_id and a.factor_id = new.id
       and a.state = 'expected' and a.expected_until > now()
     for update;
  end if;
  if v_alert is null then
    raise exception 'mfa_enrollment_not_allowed' using errcode = '42501';
  end if;
  update public.mfa_enrollment_alerts set state = 'pending', verified_at = now() where id = v_alert;
  return new;
end $$;
revoke all on function app.mfa_factor_verify_gate() from public, anon, authenticated;

create trigger mfa_factor_verify_gate
  before update on auth.mfa_factors
  for each row
  when (new.status = 'verified' and old.status is distinct from 'verified')
  execute function app.mfa_factor_verify_gate();

-- 6. Reservar un aviso pendiente de esa cuenta y crear su enlace ------------------------------------------------------------
-- El servidor trae la huella de un código nuevo (el código viaja solo en el correo). Toma UN aviso `pending` (con `skip
-- locked`: dos envíos simultáneos no toman el mismo), gasta un intento (tope 5; no más de uno cada 20 segundos), crea el
-- enlace con vigencia de 72 horas y devuelve el correo de la cuenta leído de `auth.users`. Si el factor ya no está
-- verificado, el aviso se cierra sin enviar nada.
create function public.mfa_alerts_reserve(p_user_id uuid, p_token_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_alert   public.mfa_enrollment_alerts;
  v_email   text;
  v_expires timestamptz := now() + interval '72 hours';
begin
  if p_user_id is null or p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into v_alert
    from public.mfa_enrollment_alerts a
   where a.user_id = p_user_id and a.state = 'pending' and a.attempts < 5
     and (a.last_attempt_at is null or a.last_attempt_at < now() - interval '20 seconds')
   order by a.verified_at, a.id
   limit 1
   for update skip locked;
  if not found then
    return jsonb_build_object('reserved', false);
  end if;
  if not exists (select 1 from auth.mfa_factors f
                  where f.id = v_alert.factor_id and f.user_id = p_user_id and f.status = 'verified') then
    update public.mfa_enrollment_alerts set state = 'closed', error_code = 'factor_gone' where id = v_alert.id;
    return jsonb_build_object('reserved', false);
  end if;
  select u.email::text into v_email from auth.users u where u.id = p_user_id and u.deleted_at is null;
  update public.mfa_enrollment_alerts
     set attempts = attempts + 1, last_attempt_at = now()
   where id = v_alert.id;
  if v_email is null then
    -- Sin correo no hay a quién avisar: el servidor lo trata como un envío fallido.
    return jsonb_build_object('reserved', true, 'alert_id', v_alert.id, 'factor_id', v_alert.factor_id,
                              'verified_at', v_alert.verified_at, 'email', null, 'expires_at', null);
  end if;
  insert into public.mfa_annul_links (alert_id, user_id, token_sha256, expires_at)
  values (v_alert.id, p_user_id, p_token_sha256, v_expires);
  return jsonb_build_object('reserved', true, 'alert_id', v_alert.id, 'factor_id', v_alert.factor_id,
                            'verified_at', v_alert.verified_at, 'email', v_email, 'expires_at', v_expires);
end $$;

-- 7. Cerrar un intento de envío: el proveedor aceptó el correo (`sent`) o falló (solo un código) ------------------------------
create function public.mfa_alert_settle(
  p_alert_id uuid, p_provider text, p_provider_message_id text, p_error_code text
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_code text := case when p_error_code ~ '^[a-z0-9_:.-]{1,60}$' then p_error_code else 'unknown' end;
begin
  if p_alert_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  if p_provider_message_id is not null then
    update public.mfa_enrollment_alerts
       set state = 'sent', sent_at = now(), error_code = null,
           provider = left(p_provider, 30), provider_message_id = left(p_provider_message_id, 200)
     where id = p_alert_id and state = 'pending';
    return case when found then 'sent' else 'unchanged' end;
  end if;
  update public.mfa_enrollment_alerts set error_code = v_code where id = p_alert_id and state = 'pending';
  return case when found then 'failed' else 'unchanged' end;
end $$;

-- 8. Revertir: el aviso no salió. Si el aviso espera la verificación (`expected`), solo se cierra el permiso. Si ya está
--    `pending`, queda `reverted` y sus enlaces se borran; el servidor borra entonces el factor. Un aviso ya enviado nunca se
--    revierte desde aquí. ----------------------------------------------------------------------------------------------------
create function public.mfa_alert_revert(p_user_id uuid, p_factor_id uuid, p_error_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_code  text := case when p_error_code ~ '^[a-z0-9_:.-]{1,60}$' then p_error_code else 'unknown' end;
  v_alert public.mfa_enrollment_alerts;
begin
  if p_user_id is null or p_factor_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select * into v_alert
    from public.mfa_enrollment_alerts a
   where a.user_id = p_user_id and a.factor_id = p_factor_id and a.state in ('expected', 'pending')
   order by a.created_at desc
   limit 1
   for update;
  if not found then
    return 'none';
  end if;
  if v_alert.state = 'expected' then
    update public.mfa_enrollment_alerts set state = 'closed', expected_until = now(), error_code = v_code
     where id = v_alert.id;
    return 'closed';
  end if;
  update public.mfa_enrollment_alerts set state = 'reverted', error_code = v_code where id = v_alert.id;
  delete from public.mfa_annul_links where alert_id = v_alert.id;
  return 'reverted';
end $$;

-- 9. Permisos: solo el servidor (llave maestra) ejecuta estas funciones ---------------------------------------------------------
revoke all on function public.mfa_alert_expect(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mfa_alerts_reserve(uuid, text) from public, anon, authenticated;
revoke all on function public.mfa_alert_settle(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.mfa_alert_revert(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mfa_alert_expect(uuid, uuid) to service_role;
grant execute on function public.mfa_alerts_reserve(uuid, text) to service_role;
grant execute on function public.mfa_alert_settle(uuid, text, text, text) to service_role;
grant execute on function public.mfa_alert_revert(uuid, uuid, text) to service_role;
