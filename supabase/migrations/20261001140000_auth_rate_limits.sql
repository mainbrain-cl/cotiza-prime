-- Migración 10 — Límite de intentos de ingreso y registro (H-002)
-- Cuenta solo los FALLOS, por cuenta (huella del correo) y por IP real. La usa únicamente el
-- servidor, con la llave maestra: la tabla no tiene permisos para anon ni authenticated.
-- La clave nunca es el correo ni la IP en claro: es una huella HMAC (modelo-datos.md §5.4).
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261001140000_auth_rate_limits.down.sql

create table public.auth_rate_limits (
  scope             text not null check (scope in ('login_email', 'login_ip', 'signup_ip')),
  key_hash          text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  tenant_id         uuid not null default app.platform_tenant_id()
                    references public.tenants (tenant_id) on update cascade
                    check (tenant_id = app.platform_tenant_id()),
  failures          integer not null default 0 check (failures >= 0),
  window_started_at timestamptz not null default now(),
  locked_until      timestamptz,
  updated_at        timestamptz not null default now(),
  primary key (scope, key_hash)
);
create index auth_rate_limits_updated on public.auth_rate_limits (updated_at);

create trigger auth_rate_limits_forbid_tenant_change
  before update on public.auth_rate_limits
  for each row execute function app.forbid_tenant_change();

-- RLS activa y sin políticas para personas: solo la llave maestra (que se salta la RLS) la usa.
-- La política para service_role es explícita y deja constancia de quién es el único usuario.
alter table public.auth_rate_limits enable row level security;
create policy auth_rate_limits_server_only on public.auth_rate_limits
  for all to service_role using (true) with check (true);
revoke all on public.auth_rate_limits from anon, authenticated;
grant select, insert, update, delete on public.auth_rate_limits to service_role;

-- ¿Está bloqueada esta clave? Devuelve hasta cuándo, o null si no lo está.
create function public.auth_limit_locked_until(p_scope text, p_key_hash text)
returns timestamptz
language sql stable security definer set search_path = '' as $$
  select l.locked_until
  from public.auth_rate_limits l
  where l.scope = p_scope and l.key_hash = p_key_hash and l.locked_until > now()
$$;

-- Registra un fallo. Si la ventana venció o el bloqueo terminó, la cuenta parte de cero.
-- Al llegar al máximo bloquea por p_lock_seconds. Devuelve hasta cuándo queda bloqueada, o null.
create function public.auth_limit_record_failure(
  p_scope text, p_key_hash text, p_max_failures integer, p_window_seconds integer, p_lock_seconds integer
) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_locked timestamptz;
begin
  -- Limpieza de filas viejas, para que la tabla no crezca sin fin.
  delete from public.auth_rate_limits
  where updated_at < now() - interval '1 day' and (locked_until is null or locked_until < now());

  insert into public.auth_rate_limits as l (scope, key_hash, failures, window_started_at, locked_until, updated_at)
  values (p_scope, p_key_hash, 1, now(), null, now())
  on conflict (scope, key_hash) do update set
    failures = case
      when l.window_started_at < now() - make_interval(secs => p_window_seconds)
        or (l.locked_until is not null and l.locked_until <= now()) then 1
      else l.failures + 1 end,
    window_started_at = case
      when l.window_started_at < now() - make_interval(secs => p_window_seconds)
        or (l.locked_until is not null and l.locked_until <= now()) then now()
      else l.window_started_at end,
    locked_until = case
      when l.window_started_at < now() - make_interval(secs => p_window_seconds)
        or (l.locked_until is not null and l.locked_until <= now()) then null
      else l.locked_until end,
    updated_at = now();

  update public.auth_rate_limits l
  set locked_until = now() + make_interval(secs => p_lock_seconds)
  where l.scope = p_scope and l.key_hash = p_key_hash
    and l.failures >= p_max_failures and l.locked_until is null
  returning l.locked_until into v_locked;

  if v_locked is null then
    select l.locked_until into v_locked
    from public.auth_rate_limits l
    where l.scope = p_scope and l.key_hash = p_key_hash and l.locked_until > now();
  end if;
  return v_locked;
end $$;

-- Un ingreso exitoso limpia el contador de esa cuenta.
create function public.auth_limit_clear(p_scope text, p_key_hash text) returns void
language sql security definer set search_path = '' as $$
  delete from public.auth_rate_limits where scope = p_scope and key_hash = p_key_hash
$$;

revoke all on function public.auth_limit_locked_until(text, text) from public, anon, authenticated;
revoke all on function public.auth_limit_record_failure(text, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.auth_limit_clear(text, text) from public, anon, authenticated;
grant execute on function public.auth_limit_locked_until(text, text) to service_role;
grant execute on function public.auth_limit_record_failure(text, text, integer, integer, integer) to service_role;
grant execute on function public.auth_limit_clear(text, text) to service_role;
