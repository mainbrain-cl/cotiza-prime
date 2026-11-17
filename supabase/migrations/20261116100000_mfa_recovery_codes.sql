-- Sprint 5 · H-004b etapa B · Códigos de respaldo del segundo paso (solo sus huellas) y las siete funciones que los manejan
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261116100000_mfa_recovery_codes.down.sql
-- Especificación: docs/arquitectura/h-004b-codigos-de-respaldo.md (§3.2 y §4.1) y su registro de construcción (paso 2).
--
-- El problema: quien pierde el teléfono con el segundo paso activo queda fuera. Se entrega, al activar, un juego de 10 códigos de
-- un solo uso (se muestran una sola vez; aquí solo queda su huella HMAC, calculada por el servidor). Usar uno quita el factor de la
-- aplicación (decisión D1 = A / D2 = A: la cuenta queda sin segundo paso hasta que la persona active su teléfono nuevo).
--   1. `public.mfa_recovery_codes`: una fila por código (huella, juego, factor al que respalda, y las fechas de «tomado»,
--      «usado» y «guardado»). Tabla de la plataforma, como `auth_rate_limits`: `tenant_id` fijo de la plataforma. No guarda el
--      correo ni el código.
--   2. Siete funciones SOLO del servidor (llave maestra): `mfa_recovery_codes_replace`, `mfa_recovery_code_claim`,
--      `mfa_recovery_code_complete`, `mfa_recovery_code_release`, `mfa_recovery_codes_acknowledge`,
--      `mfa_recovery_codes_status` y `mfa_recovery_codes_revoke`. Ninguna usa la sesión (`auth.uid()`): el servidor entrega la
--      cuenta, y el aislamiento entre cuentas es que toda búsqueda filtra por esa cuenta y la huella ya la incluye.
--
-- Atados al factor: cada juego guarda el `factor_id` del factor TOTP al que respalda. Si ese factor desaparece (desactivar,
-- anular o revertir de H-118, soporte), los códigos dejan de servir solos (`claim` exige un factor TOTP verificado de esa cuenta)
-- y nadie tiene que tocar el código de H-118.
--
-- Un solo uso y carreras: cada función toma un candado por cuenta (`pg_advisory_xact_lock`) y `claim` además bloquea la fila.
-- Dos `claim` del mismo código a la vez: gana uno. Un `replace` con un código tomado (cuyo factor sigue verificado) responde `busy`.
--
-- Retención: se borran los juegos cuyo factor ya no existe y tienen más de 1 día, y los códigos usados hace más de 30 días. La
-- limpieza va dentro de `replace`, `claim` y `status`, ACOTADA a 100 filas por llamada (`limit 100`) y con `skip locked`: nunca
-- espera filas de otra cuenta ni borra un lote enorme de una vez (lo que sobre lo borra la actividad siguiente); no hace falta una
-- tarea programada, y solo corre cuando hay actividad. `auth.users` en cascada: borrar la cuenta borra sus códigos.
--
-- Guardia 15 (tests/db/schema-guards.test.ts): primera sentencia `set local lock_timeout = '3s'` y, justo después, la
-- verificación de que el valor quedó puesto. Solo CREA cosas: no reescribe ninguna función ni política existente y no toca
-- `auth.mfa_factors` (el disparador de H-118 sigue igual; los códigos nunca pasan por esa tabla).
set local lock_timeout = '3s';

do $$ begin
  if current_setting('lock_timeout') <> '3s' then
    raise exception 'la migracion 20261116100000 no puede seguir: lock_timeout no quedo en 3s (vale %); aplique el archivo dentro de una transaccion', current_setting('lock_timeout');
  end if;
end $$;

-- 1. La tabla ---------------------------------------------------------------------------------------------------------------
create table public.mfa_recovery_codes (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null default app.platform_tenant_id()
                  references public.tenants (tenant_id) on update cascade
                  check (tenant_id = app.platform_tenant_id()),
  user_id         uuid not null references auth.users (id) on delete cascade,
  -- Los 10 códigos de una misma generación.
  set_id          uuid not null,
  -- Sin llave foránea: el factor se borra al desactivar, anular o revertir, y el código queda inútil solo.
  factor_id       uuid not null,
  -- Solo la huella (HMAC-SHA256 en hexadecimal, ya atada a la cuenta): nunca el código.
  code_hash       text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  claimed_until   timestamptz,
  used_at         timestamptz,
  acknowledged_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index mfa_recovery_codes_user_hash on public.mfa_recovery_codes (user_id, code_hash);
create index mfa_recovery_codes_user_open on public.mfa_recovery_codes (user_id) where used_at is null;
create index mfa_recovery_codes_created on public.mfa_recovery_codes (created_at);

create trigger mfa_recovery_codes_forbid_tenant_change
  before update on public.mfa_recovery_codes
  for each row execute function app.forbid_tenant_change();

alter table public.mfa_recovery_codes enable row level security;
create policy mfa_recovery_codes_server_only on public.mfa_recovery_codes
  for all to service_role using (true) with check (true);
revoke all on public.mfa_recovery_codes from anon, authenticated;
grant select, insert, update, delete on public.mfa_recovery_codes to service_role;

-- 2. Reemplazar el juego de una cuenta -----------------------------------------------------------------------------------------
-- Exige que `p_factor_id` sea un factor TOTP verificado de ESA cuenta (si no, `no_factor`) y exactamente 10 huellas distintas con
-- la forma correcta (si no, `CP422`). Con un código tomado ahora mismo responde `busy` (hay un uso en curso). Si todo calza,
-- borra el juego anterior, inserta el nuevo y devuelve `{result: 'ok', set_id, total}`.
create function public.mfa_recovery_codes_replace(p_user_id uuid, p_factor_id uuid, p_code_hashes text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_set uuid := gen_random_uuid();
begin
  if p_user_id is null or p_factor_id is null or p_code_hashes is null or cardinality(p_code_hashes) <> 10
     or exists (select 1 from unnest(p_code_hashes) h where h is null or h !~ '^[0-9a-f]{64}$')
     or (select count(distinct h) from unnest(p_code_hashes) h) <> 10 then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mfa_recovery|' || p_user_id::text, 0));
  -- Retención: ver el encabezado de la migración.
  delete from public.mfa_recovery_codes c where c.id in (
    select x.id from public.mfa_recovery_codes x
     where (x.created_at < now() - interval '1 day'
            and not exists (select 1 from auth.mfa_factors f
                             where f.id = x.factor_id and f.user_id = x.user_id
                               and f.factor_type = 'totp' and f.status = 'verified'))
        or (x.used_at is not null and x.used_at < now() - interval '30 days')
     limit 100
     for update skip locked);
  if not exists (select 1 from auth.mfa_factors f
                  where f.id = p_factor_id and f.user_id = p_user_id
                    and f.factor_type = 'totp' and f.status = 'verified') then
    return jsonb_build_object('result', 'no_factor');
  end if;
  -- Ocupado = un código TOMADO ahora mismo cuyo factor sigue siendo un TOTP verificado. Un código huérfano (su factor ya no existe:
  -- el servidor se cayó a mitad de un uso o el factor se quitó por otro camino) no bloquea a quien vuelve a activar.
  if exists (select 1 from public.mfa_recovery_codes c
              where c.user_id = p_user_id and c.used_at is null and c.claimed_until > now()
                and exists (select 1 from auth.mfa_factors f
                             where f.id = c.factor_id and f.user_id = c.user_id
                               and f.factor_type = 'totp' and f.status = 'verified')) then
    return jsonb_build_object('result', 'busy');
  end if;
  delete from public.mfa_recovery_codes where user_id = p_user_id;
  insert into public.mfa_recovery_codes (user_id, set_id, factor_id, code_hash)
  select p_user_id, v_set, p_factor_id, h from unnest(p_code_hashes) h;
  return jsonb_build_object('result', 'ok', 'set_id', v_set, 'total', 10);
end $$;

-- 3. Tomar un código por 2 minutos ----------------------------------------------------------------------------------------------
-- Devuelve el MISMO `{result: 'invalid'}` en cualquier caso que no sea un código vigente de ESA cuenta: argumentos sin forma, huella
-- inexistente, de otra cuenta, ya usada, tomada, o cuyo factor ya no es un TOTP verificado. Nunca dice cuál de esas cosas fue.
create function public.mfa_recovery_code_claim(p_user_id uuid, p_code_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_code public.mfa_recovery_codes;
begin
  if p_user_id is null or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('result', 'invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mfa_recovery|' || p_user_id::text, 0));
  -- Retención: ver el encabezado de la migración.
  delete from public.mfa_recovery_codes c where c.id in (
    select x.id from public.mfa_recovery_codes x
     where (x.created_at < now() - interval '1 day'
            and not exists (select 1 from auth.mfa_factors f
                             where f.id = x.factor_id and f.user_id = x.user_id
                               and f.factor_type = 'totp' and f.status = 'verified'))
        or (x.used_at is not null and x.used_at < now() - interval '30 days')
     limit 100
     for update skip locked);
  select * into v_code
    from public.mfa_recovery_codes c
   where c.user_id = p_user_id and c.code_hash = p_code_hash
     and c.used_at is null
     and (c.claimed_until is null or c.claimed_until <= now())
     and exists (select 1 from auth.mfa_factors f
                  where f.id = c.factor_id and f.user_id = c.user_id
                    and f.factor_type = 'totp' and f.status = 'verified')
   for update;
  if not found then
    return jsonb_build_object('result', 'invalid');
  end if;
  update public.mfa_recovery_codes set claimed_until = now() + interval '2 minutes' where id = v_code.id;
  return jsonb_build_object('result', 'ok', 'code_id', v_code.id, 'factor_id', v_code.factor_id);
end $$;

-- 4. Completar: el código se usó ---------------------------------------------------------------------------------------------------
-- Solo sirve para un código TOMADO y con su plazo vigente (si el plazo de 2 minutos ya pasó, otra llamada pudo tomarlo: `invalid`).
-- Marca `used_at`, borra los demás códigos de la cuenta y devuelve el correo, leído de `auth.users`, para el aviso.
create function public.mfa_recovery_code_complete(p_code_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user  uuid;
  v_email text;
begin
  if p_code_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  select c.user_id into v_user from public.mfa_recovery_codes c where c.id = p_code_id;
  if v_user is null then
    return jsonb_build_object('result', 'invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mfa_recovery|' || v_user::text, 0));
  perform 1 from public.mfa_recovery_codes c
   where c.id = p_code_id and c.used_at is null and c.claimed_until > now()
     for update;
  if not found then
    return jsonb_build_object('result', 'invalid');
  end if;
  update public.mfa_recovery_codes set used_at = now(), claimed_until = null where id = p_code_id;
  delete from public.mfa_recovery_codes where user_id = v_user and id <> p_code_id;
  select u.email::text into v_email from auth.users u where u.id = v_user and u.deleted_at is null;
  return jsonb_build_object('result', 'ok', 'email', v_email);
end $$;

-- 5. Soltar el código tomado ------------------------------------------------------------------------------------------------------
create function public.mfa_recovery_code_release(p_code_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_code_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  update public.mfa_recovery_codes set claimed_until = null where id = p_code_id and used_at is null;
  return found;
end $$;

-- 6. «Guardé mis códigos»: marca el juego vigente (con un juego viejo o ajeno responde false) ------------------------------------------
create function public.mfa_recovery_codes_acknowledge(p_user_id uuid, p_set_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or p_set_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mfa_recovery|' || p_user_id::text, 0));
  update public.mfa_recovery_codes c
     set acknowledged_at = coalesce(c.acknowledged_at, now())
   where c.user_id = p_user_id and c.set_id = p_set_id and c.used_at is null
     and exists (select 1 from auth.mfa_factors f
                  where f.id = c.factor_id and f.user_id = c.user_id
                    and f.factor_type = 'totp' and f.status = 'verified');
  return found;
end $$;

-- 7. Estado del juego vigente (códigos sin usar cuyo factor sigue verificado); sin juego, `{total: 0}` -------------------------------------
create function public.mfa_recovery_codes_status(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_set          uuid;
  v_total        integer;
  v_acknowledged boolean;
  v_created      timestamptz;
begin
  if p_user_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  -- Retención: ver el encabezado de la migración.
  delete from public.mfa_recovery_codes c where c.id in (
    select x.id from public.mfa_recovery_codes x
     where (x.created_at < now() - interval '1 day'
            and not exists (select 1 from auth.mfa_factors f
                             where f.id = x.factor_id and f.user_id = x.user_id
                               and f.factor_type = 'totp' and f.status = 'verified'))
        or (x.used_at is not null and x.used_at < now() - interval '30 days')
     limit 100
     for update skip locked);
  select c.set_id, count(*), bool_and(c.acknowledged_at is not null), min(c.created_at)
    into v_set, v_total, v_acknowledged, v_created
    from public.mfa_recovery_codes c
   where c.user_id = p_user_id and c.used_at is null
     and exists (select 1 from auth.mfa_factors f
                  where f.id = c.factor_id and f.user_id = c.user_id
                    and f.factor_type = 'totp' and f.status = 'verified')
   group by c.set_id
   order by max(c.created_at) desc
   limit 1;
  if v_set is null then
    return jsonb_build_object('total', 0);
  end if;
  return jsonb_build_object('total', v_total, 'acknowledged', v_acknowledged, 'set_id', v_set, 'created_at', v_created);
end $$;

-- 8. Borrar todos los códigos de la cuenta -----------------------------------------------------------------------------------------------
create function public.mfa_recovery_codes_revoke(p_user_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer;
begin
  if p_user_id is null then
    raise exception 'invalid_arguments' using errcode = 'CP422';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('mfa_recovery|' || p_user_id::text, 0));
  delete from public.mfa_recovery_codes where user_id = p_user_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

-- 9. Permisos: solo el servidor (llave maestra) ------------------------------------------------------------------------------------------
revoke all on function public.mfa_recovery_codes_replace(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.mfa_recovery_code_claim(uuid, text) from public, anon, authenticated;
revoke all on function public.mfa_recovery_code_complete(uuid) from public, anon, authenticated;
revoke all on function public.mfa_recovery_code_release(uuid) from public, anon, authenticated;
revoke all on function public.mfa_recovery_codes_acknowledge(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mfa_recovery_codes_status(uuid) from public, anon, authenticated;
revoke all on function public.mfa_recovery_codes_revoke(uuid) from public, anon, authenticated;
grant execute on function public.mfa_recovery_codes_replace(uuid, uuid, text[]) to service_role;
grant execute on function public.mfa_recovery_code_claim(uuid, text) to service_role;
grant execute on function public.mfa_recovery_code_complete(uuid) to service_role;
grant execute on function public.mfa_recovery_code_release(uuid) to service_role;
grant execute on function public.mfa_recovery_codes_acknowledge(uuid, uuid) to service_role;
grant execute on function public.mfa_recovery_codes_status(uuid) to service_role;
grant execute on function public.mfa_recovery_codes_revoke(uuid) to service_role;
