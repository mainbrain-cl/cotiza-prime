-- Migración 12 — La "última organización usada" es privada de cada persona (H-012)
-- Hallazgo de la prueba de aislamiento: la política de `profiles` deja leer el perfil de los
-- compañeros de la organización activa, y con él la columna `last_tenant_id`. Una persona que está
-- en dos organizaciones (A y B) y usó B por última vez dejaba ver el identificador de B a sus
-- compañeras de A. Va contra el criterio 3 de H-012.
--
-- Corrección: ninguna persona con pase puede leer `last_tenant_id` por la tabla (ni siquiera la
-- propia). La única forma de leerla es `my_last_tenant_id()`, que solo entrega la propia y solo si
-- sigue siendo miembro. Escribirla sigue permitido (permiso de actualización de la migración 2).
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261001150000_profiles_column_privacy.down.sql

-- Quitar el permiso de la tabla entera (borra también los permisos por columna) y volver a dar
-- solo las columnas que un compañero puede ver.
revoke select on public.profiles from authenticated;
grant select (user_id, tenant_id, full_name, created_at, updated_at) on public.profiles to authenticated;

-- La última organización de la persona que llama, solo si sigue siendo miembro activo de ella.
create function public.my_last_tenant_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.last_tenant_id
  from public.profiles p
  where p.user_id = auth.uid()
    and p.last_tenant_id in (select app.my_tenant_ids())
$$;
revoke all on function public.my_last_tenant_id() from public, anon;
grant execute on function public.my_last_tenant_id() to authenticated;
