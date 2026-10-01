-- Migración 1 — Cimientos
-- Extensiones, esquema interno `app`, retiro de permisos por defecto y funciones comunes.
-- Especificación: docs/arquitectura/modelo-datos.md §3.0, §4.1, §9.2.
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261001120100_foundation.down.sql

-- Extensiones -------------------------------------------------------------------
create extension if not exists pg_trgm   with schema extensions;
create extension if not exists btree_gin with schema extensions;

-- Esquema interno: NO se expone por la API (config.toml: api.schemas = public, graphql_public)
create schema if not exists app;

-- Permisos de fondo (§4.1) ---------------------------------------------------------
-- Supabase entrega por defecto todos los permisos a anon y authenticated, incluido TRUNCATE,
-- que no respeta la RLS. Se retiran; cada migración da después solo lo necesario.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from public, anon, authenticated;
-- Global (sin "in schema"): PostgreSQL da EXECUTE a PUBLIC en toda función nueva; se retira.
alter default privileges for role postgres revoke execute on functions from public;

-- Acceso al esquema interno: solo sesiones con login y la llave maestra, nunca anon.
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- Constantes con nombre (sin valores mágicos) -----------------------------------------
create function app.platform_tenant_id() returns uuid
language sql immutable as $$ select '00000000-0000-4000-8000-000000000001'::uuid $$;

-- Tope de organizaciones que una persona puede crear (pregunta 6 del modelo; ajustable con la
-- decisión pendiente 13 de PROYECTO.md §16.2).
create function app.max_tenants_per_user() returns integer
language sql immutable as $$ select 5 $$;

-- Meses que se conserva el registro de auditoría (PROYECTO.md §11.2).
create function app.audit_retention_months() returns integer
language sql immutable as $$ select 24 $$;

-- Zona horaria con que se calcula el año de la numeración (P8).
create function app.business_timezone() returns text
language sql immutable as $$ select 'America/Santiago'::text $$;

-- RUT chileno -------------------------------------------------------------------------
-- Forma canónica: sin puntos, con guion, dígito verificador en mayúscula, sin ceros a la izquierda.
create function app.normalize_rut(p text) returns text
language plpgsql immutable as $$
declare
  v    text := upper(regexp_replace(coalesce(p, ''), '[.\s-]', '', 'g'));
  body text;
begin
  if v !~ '^[0-9]+[0-9K]$' then
    return null;
  end if;
  body := regexp_replace(left(v, -1), '^0+', '');
  if body = '' then
    return null;
  end if;
  return body || '-' || right(v, 1);
end $$;

-- Valida el dígito verificador (módulo 11; resultado 11 = '0', 10 = 'K'). Espera la forma canónica.
create function app.is_valid_rut(p text) returns boolean
language plpgsql immutable as $$
declare
  body   text;
  dv     text;
  total  integer := 0;
  weight integer := 2;
  i      integer;
  calc   integer;
begin
  if p is null or p !~ '^[1-9][0-9]{0,7}-[0-9K]$' then
    return false;
  end if;
  body := split_part(p, '-', 1);
  dv   := split_part(p, '-', 2);
  for i in reverse length(body)..1 loop
    total  := total + substr(body, i, 1)::integer * weight;
    weight := case when weight = 7 then 2 else weight + 1 end;
  end loop;
  calc := 11 - (total % 11);
  return dv = case calc when 11 then '0' when 10 then 'K' else calc::text end;
end $$;

-- Funciones puras: las usan restricciones y valores por defecto, que se ejecutan con los
-- permisos de quien escribe la fila.
grant execute on function
  app.platform_tenant_id(), app.max_tenants_per_user(), app.audit_retention_months(),
  app.business_timezone(), app.normalize_rut(text), app.is_valid_rut(text)
  to authenticated, service_role;

-- Triggers comunes (§3.0) ---------------------------------------------------------------
-- Tres variantes, porque asignar un campo que la tabla no tiene falla al ejecutar:
--   set_updated_at  -> tablas con solo updated_at
--   set_row_meta    -> tablas con created_at y updated_at
--   set_row_meta_by -> además created_by y updated_by (los pone la base, nunca el navegador)
create function app.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create function app.set_row_meta() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;

create function app.set_row_meta_by() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;

-- P5: el tenant_id de una fila no cambia nunca. (Una migración de acoplamiento a un hub,
-- STACK.md §5b, debe desactivar este trigger de forma explícita dentro de su transacción.)
create function app.forbid_tenant_change() returns trigger
language plpgsql as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant_id is immutable' using errcode = '42501';
  end if;
  return new;
end $$;

-- P10: tablas de solo agregar.
create function app.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;
